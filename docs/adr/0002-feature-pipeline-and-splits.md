# ADR-0002: Feature pipeline placement & data-split strategy

- **Status:** Accepted
- **Date:** 2026-08-26
- **Deciders:** mishr (solo/lead builder)

## Context

The crop ranker is trained offline (Phase 1) and served online (Phase 2, inside
the FastAPI `ai` service). Any difference between how features are computed at
training time and at serving time — a different default, a different category
encoding, a column in a different order — silently degrades predictions in a way
that is nearly impossible to spot from the outside. This is *train/serve skew*,
the single most common and most expensive bug in a deployed ML system.

Two facts about the Aaroh data make this sharper:

- **`soil_temp_c` is measured by the probe but not yet logged by firmware.** It is
  present in training data but will be *absent* at inference until the firmware
  gap (guide §13) is closed. The pipeline must handle a feature that exists at
  train time and is missing at serve time.
- **The hard label is a *sample* from the soft distribution**, not its argmax, so
  `argmax(soft) == hard` only ~55 % of the time. Splitting and evaluation have to
  respect that we are learning a distribution, not a single class.

## Decision

**One shared transform module, fitted once, saved, and reused verbatim.**
`features/feature_pipeline.py` is the only place raw inputs become model
features. Training fits a `FeaturePipeline` on the **train fold only** and
serialises it to `feature_spec.json` inside the model artifact. The golden tests
(Phase 1) and the inference service (Phase 2) **load that exact object** rather
than re-deriving features. There is deliberately no second implementation of the
feature logic anywhere in the codebase.

**Missing-at-inference is a first-class case, not an error.** `soil_temp_c`
absent at serve time maps to `NaN`, and we do **not** impute it — the GBDT models
(LightGBM/XGBoost) handle `NaN` natively by learning a default split direction.
Inventing a value would be a quiet lie; a `NaN` is honest and the model is trained
to cope with it.

**Deterministic, seeded splits — stratified by hard label *for now*.**
`splits.py` produces byte-for-byte reproducible train/val/test folds (default
70/15/15), stratified by the hard label so every crop appears in each fold in
roughly its natural proportion. Reproducibility is what lets a registered model's
metrics be re-derived later.

**When real field data arrives, switch to a grouped split** (group by field id):
multiple readings from the same physical field must never straddle train and
test, or spatial correlation leaks and the model looks better than it is. The
synthetic v2 data has **no field id**, so stratified-by-label is correct today;
this is flagged in `splits.py` and must change before the first hardware-collected
dataset is trained on.

## Consequences

- The feature contract lives in exactly one file and travels *with* the model, so
  a model and its transform can never fall out of step.
- The inference service (Phase 2) does not re-implement feature engineering; it
  imports `FeaturePipeline` and loads the saved `feature_spec.json`.
- Reproducibility is guaranteed given a seed + ratios, which underpins the
  registry's promise that stored metrics are re-derivable.
- A `TODO` with teeth: the split strategy is knowingly interim. Training on real
  field data before switching to a grouped split would produce optimistic,
  untrustworthy metrics.

## Alternatives considered

- **Recompute features independently in training and serving** — simplest to
  write, but reintroduces exactly the skew this ADR exists to prevent. Rejected.
- **Impute `soil_temp_c`** (mean/median) when missing — hides the firmware gap
  behind a plausible-looking number and biases predictions toward the imputed
  value. Rejected in favour of honest `NaN` + native GBDT handling.
- **Grouped split now** — correct in principle, but impossible without a field id;
  the v2 data has none. Deferred, with the trigger condition written down.
