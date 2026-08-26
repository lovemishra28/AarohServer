# Phase 2 — Block 1 Checkpoint: Python Core

**Date:** 2026-08-26
**Scope of this block:** region config → soil classifier → deterministic agronomy engine → ONNX-backed inference service → FastAPI app → command-line tool.
**Status:** Built and sandbox-verified. **Stopping here for your review and sign-off before I start the Node/Express half (Block 2).**

> **Read this first — the numbers below are real, but the *checks* are sandbox-emulated.**
> The fertiliser arithmetic, the CLI runs, and the ranked-crop output in this report were produced by *actually running the code* against the real trained model, so those numbers are genuine. But `pytest` and `ruff` are **not installed in my sandbox**, so I ran the test suite through a hand-written harness and the lint rules by manual scan. **Please run the real `pytest -q` and `ruff check .` on your machine** (commands at the end) and paste the output — that is the authoritative pass, not mine.

---

## 1. Definition of Done (from SERVER_DEVELOPMENT_GUIDE §10)

> `POST /v1/fields/:id/recommendations` returns a correct `RecommendationResult` end-to-end via curl, with a hand-entered reading; every fertiliser number unit-correct and golden-tested.

Block 1 delivers everything *behind* that HTTP route — the engine, the model service, and the same `RecommendationResult` produced from a hand-entered reading **via a command line** (`aaroh-recommend`). Block 2 wires it to the Node API + Postgres so the curl form of the DoD is met. Splitting here is the checkpoint you asked for.

---

## 2. What was built

**Domain data (versioned, region-scoped, provisional):**
- `services/agronomy/regions/chambal/2026.08-provisional.json` — the single source of truth: products & prices, soil-rating thresholds, per-crop RDF table, dose model, legume list, and a `_meta.review_required` list of everything needing your sign-off.
- `services/agronomy/regions/chambal/manifest.json` — points to the active version, so a future STCR-calibrated table drops in without code changes.

**Engine (deterministic, no ML — ADR-0004):**
- `config.py` — loads & validates the region config; asserts all 20 canonical crops present and Urea/DAP/MOP defined.
- `classify.py` — converts the probe's **elemental** mg/kg to kg/ha (×1.95) and rates each nutrient Low/Medium/High. **No oxide conversion** on this path (see §6).
- `engine.py` — the core: class-adjusted dose → whole 50 kg bags → rupee cost, split into Segment A (grow now, no fertiliser) and Segment B (viable with a stated cost), with rationale codes and warnings.

**Serving:**
- `inference/model_service.py` — loads the active model from the file registry; prefers ONNX (works in-sandbox), falls back to native LightGBM. Never raises on load; records a readable error instead.
- `inference/schemas.py` — pydantic v2 request/response contracts.
- `inference/app.py` — FastAPI app: `GET /health`, `POST /predict`, `POST /recommend`, `POST /reload`.
- `inference/cli.py` — `aaroh-recommend`, the command-line proof.

---

## 3. End-to-end proof (the CLI actually runs)

Ranked mode calls the **real trained model** (`crop-ranker@1.0.0`, via ONNX) and then the engine. Example — alkaline low-fertility reading, 1.2 ha, top 3:

```
region      : chambal   area: 1.2 ha
model       : crop-ranker@1.0.0
agronomy    : chambal-stcr@2026.08-provisional
soil test   : N Low (195 kg/ha)  P Low (8)  K Low (98)

── Segment B · viable with fertiliser (20) ──
  Mustard (सरसों)  score 0.406  [N_ADD_UREA+P_ADD_DAP+K_ADD_MOP]
      dose (kg/ha): N 100  P₂O₅ 50  K₂O 37.5
      DAP   × 3 bag(s) (150 kg) → P2O5 69kg, N 27kg
      Urea  × 4 bag(s) (200 kg) → N 92kg
      MOP   × 2 bag(s) (100 kg) → K2O 60kg
      cost: ₹8,634
  ...
── Warnings ──
  • npk_proxy_uncalibrated: probe N/P/K are uncalibrated proxy values...
  • agronomy_config_provisional: dose table and thresholds are seeded defaults...
```

Single-crop mode (`--crop`) skips the model entirely — useful for auditing the engine in isolation. A legume on rich soil correctly lands in Segment A with `LEGUME_FIXES_N` and zero cost.

---

## 4. Hand-verified fertiliser numbers

Each row was computed by hand and is locked by a golden test. Allocation rule: **DAP meets P₂O₅ first (crediting its incidental 18% N), Urea meets the residual N, MOP meets K₂O.** Whole 50 kg bags, round-half-up.

| Case | Field need (N / P₂O₅ / K₂O kg) | Result | Cost | Note |
|---|---|---|---|---|
| Golden | 48 / 24 / 0 | DAP×1 + Urea×2 | **₹1,942** | DAP's 9 kg N credited → Urea covers only 39 kg |
| DAP-N-credit | 9 / 23 / 0 | DAP×1 only | ₹1,350 | 9 kg N fully covered by DAP credit → no Urea |
| Round-half-up | 0 / 0 / 75 | MOP×3 | ₹5,100 | 125 kg = 2.5 bags → **3** (farmer buys enough), not 2 |
| Empty | 0 / 0 / 0 | (none) | ₹0 | Segment A |
| Wheat @1.0 ha, all-Low | 150 / 75 / 50 | DAP×3 + Urea×5 + MOP×2 | ₹8,930 | dose = RDF 120-60-40 × 1.25 |
| Mustard @1.2 ha, all-Low | 120 / 60 / 45 | DAP×3 + Urea×4 + MOP×2 | ₹8,634 | K₂O 45 kg → 1.5 bags → round-up to 2 |

> **Correction to my earlier note:** I had previously quoted Wheat@1.0 ha as ₹7,230. That was wrong — it assumed K₂O stayed at 40. Because K is Low here, K₂O = 40 × 1.25 = **50**, which needs 2 MOP bags, giving **₹8,930**. The engine and its golden test are consistent; the ₹7,230 was a stale figure.

---

## 5. Test & lint status — **SANDBOX-EMULATED**

- **Tests (my harness):** 75 passed, 0 failed, 1 module skipped (`test_health` — needs `pytest` + `fastapi`, absent here). 30 of the 75 are new this block (engine golden tests, config, classify, model service). Python `Future/Deprecation/Runtime` warnings were escalated to errors → zero warnings.
- **Lint (my manual scan of E/F/I/UP/B):** clean after two fixes — one over-length line in the CLI, and three `raise HTTPException` sites in `app.py` now chain with `from exc` (ruff **B904**).

**Please run these for real and paste the output:**

```bash
cd AAROH-Server/ai
pip install -e ".[dev]"        # brings in pytest, ruff, fastapi, lightgbm
ruff check .
pytest -q
```

I expect green, but your run is the one that counts.

---

## 6. Note on the "oxide trap" (why P is classified on an elemental basis)

The probe reports **elemental** P and K (mg/kg); fertilisers are graded in **oxide** (P₂O₅, K₂O). In this class-based v1 the RDF table is *already stated in oxide* and products are *graded in oxide*, so the elemental→oxide conversion is **not on the number path**. Classification is done on an elemental basis against standard ICAR limits (Olsen-P < 10 kg/ha = Low, etc.). The 2.291 / 1.205 conversion factors are kept in the config, **reserved** for the future STCR equation. A dedicated test (`test_phosphorus_uses_elemental_not_oxide_threshold`) pins this so no one "helpfully" reintroduces the conversion and silently misclassifies P.

---

## 7. Provisional data — needs your sign-off

You committed to supplying the authoritative dose table; everything below is a clearly-flagged placeholder so the pipeline runs today.

**7a. Per-crop RDF (N-P₂O₅-K₂O kg/ha) — the big one.** These are generic Indian recommended doses, **not** Chambal/MP-specific. Please validate or replace:

| Crop | हिंदी | N | P₂O₅ | K₂O | Crop | हिंदी | N | P₂O₅ | K₂O |
|---|---|--:|--:|--:|---|---|--:|--:|--:|
| Rice | धान | 100 | 50 | 50 | Urad* | उड़द | 0 | 40 | 20 |
| Wheat | गेहूँ | 120 | 60 | 40 | Mustard | सरसों | 80 | 40 | 30 |
| Maize | मक्का | 120 | 60 | 40 | Cotton | कपास | 120 | 60 | 60 |
| Bajra | बाजरा | 80 | 40 | 20 | Sugarcane | गन्ना | 250 | 115 | 115 |
| Jowar | ज्वार | 80 | 40 | 20 | Jute | जूट | 60 | 30 | 30 |
| Ragi | रागी | 60 | 30 | 20 | Potato | आलू | 180 | 80 | 100 |
| Soybean* | सोयाबीन | 0 | 60 | 40 | Tomato | टमाटर | 150 | 60 | 60 |
| Groundnut* | मूंगफली | 0 | 40 | 40 | Onion | प्याज | 110 | 50 | 50 |
| Chickpea* | चना | 0 | 40 | 20 | Garlic | लहसुन | 100 | 50 | 50 |
| Arhar* | अरहर | 0 | 45 | 20 | Moong* | मूंग | 0 | 40 | 20 |

*\* = legume: N-RDF set to 0 (fixes atmospheric N). Confirm whether you want a starter dose (~20 kg N/ha).*

**7b. Six modelling choices** (from `_meta.review_required`):
1. **Class multipliers** Low=1.25, Medium=1.0, **High=0.0**. The High=0 rule is what makes a sufficient nutrient add nothing. Confirm.
2. **Legume N = 0** (starter N omitted). Confirm, or give a starter figure.
3. **Soil-test thresholds** — standard ICAR class limits (N 280/560, Olsen-P 10/25, K 110/280 kg/ha). The probe reports a *proxy*, not wet-chemistry values — hence the standing `npk_proxy_uncalibrated` warning until per-device calibration exists.
4. **Prices** (Urea ₹296, DAP ₹1,350, MOP ₹1,700 per bag) — provisional retail; verify against a local Chambal dealer.
5. **Bag size** — v1 models *all* products as 50 kg bags (the frozen `bags_50kg` field). Real urea is 45 kg. Keep 50 kg notional, or evolve the contract to per-product sizes?
6. **Rounding** — round-half-up to whole bags. Alternative is always round *up* (guarantees adequacy but over-applies). Which do you want?

---

## 8. Deferred to Block 2 (Node/Express half)

Full v1 DB schema + migrations (farmers/devices/fields/readings/recommendations/model_registry/feedback, PostGIS, CHECK constraints); JWT + RBAC with a dev OTP stub; the Express modules; the Node→Python client; persisting recommendations; seeding Postgres from the canonical JSON; `openapi.yaml`; and the full curl end-to-end that formally closes the DoD.

**One sequencing question:** the DB schema/migrations (task #7) were originally grouped into "Block 1." I've kept them for Block 2 since they belong with the Node API that uses them. If you'd rather I land the schema *now* as part of this block, say so.
