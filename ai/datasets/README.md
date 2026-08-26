# Datasets

Four zones, in dependency order. Data flows **one way**: `raw → interim →
processed`. Nothing downstream is ever hand-edited, and nothing writes back
upstream.

| Zone | Committed? | What lives here |
|---|---|---|
| `raw/` | **yes** | Immutable source data + `SOURCE.md` (provenance + SHA-256). Never edited in place. |
| `interim/` | no (`.gitkeep` only) | Intermediate artefacts from a pipeline run (e.g. aligned/joined frames). Disposable. |
| `processed/` | no | Model-ready matrices if we ever cache them. Disposable — regenerated from `raw`. |
| `external/` | no | Third-party reference data pulled in later (price tables, region config exports). |

The training pipeline reads **only** from `raw/` and treats every file there as
read-only. Each run records the raw file's `dataset_hash` in the model registry,
so a result can always be traced back to the exact bytes it was trained on. That
guarantee breaks the moment someone edits a file in `raw/` — so don't. New data
becomes `v3` beside the `v2` files.
