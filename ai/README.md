# Aaroh — AI subsystem

Everything numeric in Aaroh lives here: the **crop ranker** (a probabilistic ML
model that decides *which* crops suit a field) and, from Phase 2, the
**deterministic agronomy engine** (which decides *how much* fertiliser and what
it costs). This package is `aaroh_ai`. It ships as a private FastAPI service that
only the Node `api` calls — see the top-level [`README.md`](../README.md) for how
the three services fit together.

- **Runtime:** Python 3.11+ (the container pins 3.12).
- **What Phase 1 delivers:** a frozen, registered crop-ranker plus an HTML
  evaluation report you could put in front of an agronomist — with golden tests
  passing and every confusion pair explainable.

If you read nothing else, read the next section. It is the reason this subsystem
is built the way it is, and the source of the one number that otherwise looks
like a bug.

---

## The one thing that shapes everything: crop choice is a *ranking*, and the hard label is a *sample*

The training data (`datasets/raw/`, v2, 10 000 rows) gives every field two
targets:

- a **soft label** — a probability distribution over 20 crops (how well each
  crop suits that field), and
- a **hard label** — a *single* crop **sampled** from that distribution, not its
  argmax.

Because the hard label is sampled, `argmax(soft) == hard` for only **55.46 %** of
rows. That figure is a hard **ceiling** on top-1 accuracy measured against the
hard label: even a perfect model that reproduced the soft distribution exactly
would "disagree" with the sampled hard label ~44 % of the time. So top-1-vs-hard
is a **misleading** headline — a model can score ~0.55 there and be excellent.

The whole subsystem is therefore built around ranking, not classification:

- We train on the **soft distribution**, not the single crop.
- We evaluate primarily with **NDCG@3** (soft probabilities as graded relevance)
  and **KL divergence** (how close the predicted distribution is to the true
  one), plus top-k coverage and calibration (ECE / Brier).
- The **HTML eval report opens by explaining the ~55 % ceiling**, so nobody ever
  mistakes it for a broken model.

This is spelled out in `datasets/raw/SOURCE.md` and enforced in code: data
validation even reprints the measured `argmax_soft_vs_hard_agreement` on every
run.

---

## Two engines, never merged

The clearest way to make advice both trustworthy and debuggable is to keep the
statistical part and the arithmetic part apart:

| Engine | Kind | Answers | Status |
|---|---|---|---|
| **Crop ranker** | probabilistic ML (GBDT) | *Which* crops suit this field, ranked with confidence | **Phase 1 (this)** |
| **Agronomy engine** | deterministic formulas | *How much* fertiliser, in real bags, and what it costs | Phase 2 |

A ranking model should never emit a rupee figure, and a fertiliser calculation
should never be a black box. Keeping them separate means every number a farmer
sees is either a calibrated probability or a transparent calculation — never a
guess dressed up as arithmetic. Rationale in
[`../docs/adr/0004-two-engines.md`](../docs/adr/0004-two-engines.md).

A related rule enforced elsewhere: **field size is applied only *after*
prediction; it is never a model feature.**

---

## Trust is enforced, not hoped for

Four mechanisms make a run's output something you can defend:

**One transform, shared.** `features/feature_pipeline.py` is the *single* place
raw sensor/weather/soil inputs become model features. Training fits it on the
train fold only and saves it (`feature_spec.json`) beside the model; the golden
tests here and the inference service in Phase 2 load that exact object. There is
no second copy of the feature logic to drift out of sync — the classic
train/serve skew bug is designed out.
[`../docs/adr/0002-feature-pipeline-and-splits.md`](../docs/adr/0002-feature-pipeline-and-splits.md)

**`soil_temp_c` is optional at inference.** The probe firmware measures soil
temperature but does not yet log it. Rather than pretend, the pipeline tolerates
it being **missing at serve time** (it becomes `NaN`; GBDTs handle that
natively — no imputation that would invent a value). Training still uses it where
present.

**Gates decide *activation*, not *registration*.** *Every* run is recorded in the
model registry — a full audit trail, successes and failures alike. But a model
only becomes the **active** one if it clears its gates: Top-3 not below the
current active model, NDCG@3 not worse, ECE under threshold, and **all** golden
tests passing. A model that fails is frozen and visible but never served. (The
dummy smoke model, for instance, registers but never activates.)
[`../docs/adr/0003-file-model-registry.md`](../docs/adr/0003-file-model-registry.md)

**Agronomic golden tests.** `evaluation/golden.py` builds sanity cases from the
per-crop ranges (e.g. a flooded, low-pH field should rank rice highly; an arid
alkaline field should not). These run through the *same* feature pipeline as
serving, and a single failure fails the gate.

---

## Layout

```
ai/
├─ pyproject.toml            # base deps + [train] and [dev] extras
├─ Dockerfile                # serve image (base deps only — no training libs)
├─ datasets/
│  └─ raw/                   # IMMUTABLE inputs (v2). Never edit in place.
│     ├─ master_crop_training_data_v2.csv   # features + hard label (10k×12)
│     ├─ crop_soft_labels_v2.csv            # soft labels (10k×20)
│     ├─ crop_ranges_v2.md                  # per-crop ranges → golden tests
│     └─ SOURCE.md                          # provenance, SHA-256s, the 55 % note
├─ src/aaroh_ai/
│  ├─ data/         loading.py, validation.py       # load + fail-loud data tests
│  ├─ features/     feature_pipeline.py             # THE shared transform
│  ├─ evaluation/   metrics.py, golden.py, report.py # ranking metrics + HTML report
│  ├─ training/     splits.py, models.py, tuning.py,
│  │                registry.py, pipeline.py, train.py, configs/*.yaml
│  ├─ export/       onnx_export.py                  # freeze classifier → ONNX
│  └─ inference/    app.py                          # FastAPI serve (Phase 2 wires the model)
├─ tests/           45 tests, fixture-free (run under pytest)
└─ models/          GENERATED: registry/registry.json + artifacts/<version>/
```

---

## Install

Phase-1 work (training, evaluation, export) needs the `train` and `dev` extras:

```bash
cd ai
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[train,dev]"
```

The base install (`pip install -e .`) is only the serve runtime — FastAPI, numpy,
pandas, and the shared feature pipeline. The heavy libraries (LightGBM, XGBoost,
Optuna, ONNX, matplotlib, scikit-learn) are imported **lazily**, so importing
`aaroh_ai` never pulls them in; they are only needed when you actually train,
tune, or export.

---

## Train a model

Training is one command per config. It runs the whole linear, auditable pipeline:

```
load → validate → features → split → [tune] → fit → evaluate →
golden → gates → freeze artifact → register → [ONNX] → report
```

```bash
cd ai
# the v1 baseline: LightGBM, softprob objective, activates if gates pass
python -m aaroh_ai.training.train --config src/aaroh_ai/training/configs/crop_ranker_softprob_v1.yaml
```

The three shipped configs:

| Config | Model / objective | Activates? | ONNX? | Purpose |
|---|---|---|---|---|
| `crop_ranker_softprob_v1.yaml` | LightGBM · multiclass softprob | yes (if gates pass) | yes | The **baseline** production ranker. |
| `crop_ranker_lambdamart_v1.yaml` | LightGBM · LambdaMART (LTR) | no (challenger) | no (deferred) | A learning-to-rank **challenger** to compare against the baseline. |
| `crop_ranker_dummy_smoke.yaml` | pure-numpy dummy | no (dummy never activates) | no | A **smoke test** — exercises the full pipeline with zero ML libs. |

The CLI exits `0` if the gates passed and `1` if they did not (so it is usable in
CI). It prints top-k with the ceiling reminder, NDCG@3/KL, ECE/Brier, the golden
tally, each gate check, ONNX parity, the gate verdict, whether the model
activated, and the report path.

### What a run produces

```
models/
├─ registry/registry.json          # the audit trail + which version is active
└─ artifacts/<name>@<version>/
   ├─ model.<json|txt>             # the frozen ranker
   ├─ feature_spec.json            # the EXACT transform used (anti-skew)
   ├─ model.onnx                   # only for a classifier that cleared its gates
   ├─ metadata.json                # record + gates + ONNX parity
   └─ eval_report.html             # open this in a browser
```

Open `eval_report.html` in any browser — it is self-contained (charts embedded as
base64), leads with the ceiling explanation, and shows headline metrics, the gate
table, a reliability diagram, a row-normalised confusion matrix, the most-confused
crop pairs, per-class precision/recall/F1, and the golden results.

---

## Test and lint

```bash
cd ai
ruff check .
pytest            # 45 tests
```

The tests are deliberately **fixture-free** (every `test_*` takes no arguments) and
avoid the heavy ML libraries where they can, so the suite is fast and portable.
The pieces that genuinely need LightGBM/XGBoost/ONNX (the real GBDT fit and the
ONNX parity check) are exercised by actually training a config on your machine —
run the baseline config above and confirm it reaches the gate verdict.

---

## Notes for the next contributor

- **The raw datasets are immutable.** If the data changes, land a `v3` beside v2;
  never edit v2 in place, or past runs' `dataset_hash` stops being reproducible.
- **Splits are stratified by label for now.** The synthetic v2 data has no field
  id. When real field data arrives, switch to a **grouped split** (group by field)
  so multiple readings from one field can't straddle train and test — otherwise
  the model looks better than it is. Flagged in `splits.py` and ADR-0002.
- **ONNX export is classifier-only.** Exporting LTR objectives to ONNX is
  deferred; `export_to_onnx` raises `NotImplementedError` for LambdaMART rather
  than emit a graph it can't verify for parity.
- **The registry is file-based (not MLflow).** It mirrors the Postgres
  `model_registry` columns so the Node contract is unchanged. Rationale and the
  migration path in ADR-0003.

## Architecture decisions

- [ADR-0002 — Feature pipeline placement & data-split strategy](../docs/adr/0002-feature-pipeline-and-splits.md)
- [ADR-0003 — File-based model registry](../docs/adr/0003-file-model-registry.md)
- [ADR-0004 — Two engines: probabilistic ranker vs deterministic agronomy](../docs/adr/0004-two-engines.md)
