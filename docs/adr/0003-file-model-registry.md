# ADR-0003: File-based model registry

- **Status:** Accepted
- **Date:** 2026-08-26
- **Deciders:** mishr (solo/lead builder)

## Context

Phase 1's definition of done requires a **frozen, registered** model: something
that records which models have been trained, with what metrics, and — crucially —
**which one is live**. `SERVER_DEVELOPMENT_GUIDE.md` suggests MLflow for this.

The realities this has to fit:

- A **solo builder**, developing partly in a **network-restricted sandbox** where
  standing up an MLflow tracking server (or reaching a hosted one) is friction we
  do not want on the critical path.
- The Node `api` will eventually read "which model is active" to call the AI
  service. The guide already models this as a Postgres **`model_registry`** table.
  Whatever we build now must not force a rewrite of that contract later.
- Everything about Phase 1 is about **auditability**: every run recorded, every
  activation explainable.

## Decision

**A file-based registry that mirrors the Postgres `model_registry` schema.**
`training/registry.py` implements a `FileRegistry` backed by a single
`models/registry/registry.json`, with a `ModelRecord` whose fields are the same
columns the Postgres table will have: `version, algo, objective, trained_at,
dataset_hash, metrics, artifact_uri, feature_spec_uri, is_active, notes, tags`.

Key properties:

- **Every run is registered** — successes and failures alike — so the file is a
  complete audit trail.
- **Registration ≠ activation.** A record's `is_active` flips true only when the
  training pipeline's gates pass (see below). Exactly one record can be active at
  a time; setting a new one active clears the previous (`_set_single_active`).
- **Writes are atomic** (`tempfile` + `os.replace`) so an interrupted run can
  never corrupt the registry.
- **Latest is resolved by semantic version** (then `trained_at` as a tiebreak),
  so `crop-ranker@1.10.0` correctly outranks `crop-ranker@1.9.0`.
- The artifact directory (`artifacts/<version>/`) holds the frozen model, the
  `feature_spec.json`, the ONNX graph (when applicable), `metadata.json`, and the
  HTML eval report — so a record points at a fully self-describing bundle.

**Gates decide activation.** The pipeline registers a model as active only if
Top-3 is not below the current active model, NDCG@3 is not worse, ECE is under
threshold, and *all* golden tests pass. A dummy or failing model is frozen and
visible but never served.

## Consequences

- Zero infrastructure: no tracking server, no network dependency — training runs
  anywhere, including the sandbox.
- Because the JSON mirrors the eventual table columns, Phase 2 can load the
  registry into Postgres (or have the API read it) **without changing the shape
  of the data** — the migration is a load, not a redesign.
- The registry file is human-readable and diffable, which suits a solo builder
  reviewing what changed between runs.
- We forgo MLflow's UI, artifact browser, and experiment comparison. For a single
  builder with an HTML report per run, that is an acceptable trade today.

## Alternatives considered

- **MLflow (guide's suggestion)** — richer tracking UI and ecosystem, but needs a
  server/store and network access, which the sandbox blocks and a solo pilot does
  not yet justify. The file registry deliberately mirrors its concepts (runs,
  metrics, a registered/active model) so adopting MLflow later is not precluded.
- **Postgres `model_registry` table now** — this is the eventual home, but wiring
  the Python training pipeline to the database mid-Phase-1 couples training to a
  running DB. Keeping it in a file that mirrors the schema defers that coupling to
  Phase 2 without any data-model cost.
