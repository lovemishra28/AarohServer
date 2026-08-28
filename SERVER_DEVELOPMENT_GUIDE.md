# Aaroh — Server & AI Development Guide

**Repository:** `aaroh-server`
**Scope:** Backend infrastructure, database, APIs, and the complete AI/ML subsystem.
**Version:** 1.0 · **Date:** 2026-08-25 · **Status:** Pre-development (greenfield)
**Companion document:** `CLIENT_DEVELOPMENT_GUIDE.md` (in `aaroh-client`)

> This guide is the technical constitution for everything that runs off-device. It assumes the master project documentation (`Aaroh_Master_Documentation.docx`) as the source of truth for domain decisions and only restates domain facts where a build decision depends on them. Read §1 and §2 before writing any code.

---

## Table of Contents

0. [How to use this guide](#0-how-to-use-this-guide)
1. [Guiding principles & current status](#1-guiding-principles--current-status)
2. [Master execution flow (the roadmap spine)](#2-master-execution-flow-the-roadmap-spine)
3. [Backend architecture](#3-backend-architecture)
4. [Repository & folder structure](#4-repository--folder-structure)
5. [Database planning](#5-database-planning)
6. [API planning](#6-api-planning)
7. [AI system planning](#7-ai-system-planning)
8. [AI training strategy](#8-ai-training-strategy)
9. [Server-side AI architecture (deep dive)](#9-server-side-ai-architecture-deep-dive)
10. [Development phases (server track)](#10-development-phases-server-track)
11. [Deployment strategy](#11-deployment-strategy)
12. [Testing & quality gates](#12-testing--quality-gates)
13. [Risk register & load-bearing gaps](#13-risk-register--load-bearing-gaps)
14. [Quick reference](#14-quick-reference)

---

## 0. How to use this guide

This document is written for a **solo/lead builder** (you) working across firmware, backend, and AI, with the explicit goal of reaching a **field-pilot-ready v1** in the Gwalior/Chambal division of Madhya Pradesh. It is therefore sequenced as a **single path**, not parallel team tracks — each phase leaves you with something demoable so momentum never depends on a distant "big bang" integration.

Three reading modes:

- **Planning:** read §1–§2 for the what-before-what and the dependency graph.
- **Building a specific layer:** jump to §3–§9 for architecture, DB, API, and AI specifics.
- **Executing week to week:** work §10 top to bottom; each phase has entry criteria, exit criteria, and a definition of done.

Where a decision is genuinely reversible I mark it **[default]** and name the escape hatch. Where a decision is expensive to reverse I mark it **[load-bearing]** and explain why.

---

## 1. Guiding principles & current status

### 1.1 Non-negotiable principles

These come directly from Aaroh's purpose and must survive every refactor:

1. **Advice is expressed in purchasable physical units.** The system's output is not "add 40 kg N/ha"; it is "≈ 2 bags (50 kg) of Urea + 1 bag of DAP for your field." Everything upstream exists to make that final sentence correct.
2. **Two engines, deliberately separated. [load-bearing]** A *probabilistic ML ranker* decides *which* crops suit the field; a *deterministic agronomy engine* decides *how much* fertiliser each ranked crop needs and what it costs. These never merge into one model. The ML model is allowed to be fuzzy; the fertiliser maths must be auditable and exact.
3. **Unit safety is a first-class concern. [load-bearing]** Every nutrient value carries its unit and basis in its name — `n_mgkg` (sensor, elemental, mass basis) vs `n_kgha` (converted, area basis); `p_mgkg` (elemental) vs `p2o5_kgha` (oxide). A bare `p` is a bug. The "oxide trap" (P₂O₅ = P × 2.291, K₂O = K × 1.205) and the mg/kg→kg/ha factor (**1.95** for the standard 15 cm plough layer at bulk density 1.3) are applied in exactly one place each, and never silently.
4. **Field size is a business filter, never a model feature. [load-bearing]** The ranker never sees hectares. Area is applied *after* prediction to scale quantities and cost.
5. **Offline-first, honest about uncertainty.** Sensor NPK is an uncalibrated EC-derived proxy, not lab-grade. The backend must record provenance and never present proxy values with false precision.
6. **Region v1 = Chambal.** Calibration, crop bands, and price tables are tuned for Gwalior/Chambal MP first. The architecture allows a `region` dimension so v2 can expand without a rewrite.

### 1.2 Current status snapshot (2026-08-25)

| Layer | State | Consequence for the server track |
|---|---|---|
| Hardware sensing / OLED / RTC / SD logging | Substantially built | Reading *format* is knowable now; lock the ingest schema early. |
| Firmware temperature logging | **Measured but NOT logged** | Blocks GDD/growth tracking. Server design must tolerate missing temperature history. |
| Firmware GPS | Writes literal `GPS:PENDING` | Blocks all geospatial features until firmware is fixed. Schema must accept null geometry. |
| v2 training dataset (10k causal soft-labelled rows) | Complete | AI Phase can start **immediately** — this is the least-blocked, highest-value work. |
| Trained crop model | Not trained | First real deliverable of the AI track. |
| Backend / API / PostGIS / BLE | Not started | This document. |

**Strategic implication:** the AI dataset is done and depends on nothing else, so **AI trustworthiness is the first thing to build** (Phase 1). It de-risks the core value proposition while firmware gaps are still being closed in parallel by future-you.

---

## 2. Master execution flow (the roadmap spine)

This is the canonical order for the *whole program*. Both this guide (§10) and the client guide's roadmap map onto these phase numbers.

### 2.1 Why this order

As a solo builder you optimise for (a) de-risking the thing most likely to be wrong, (b) always having a demo, and (c) never blocking yourself on an external dependency you don't control. That yields:

```
Phase 0  Foundations        repos, tooling, CI, env, migrations baseline
Phase 1  AI trustworthiness train + calibrate + evaluate the crop ranker on the v2 data
                            → FROZEN model artifact v1  (no app/backend dependency)
Phase 2  Backend core       Node API + Postgres/PostGIS + auth
                            + Python FastAPI inference service (wraps frozen model)
                            + deterministic agronomy/cost engine
                            → /recommend works via curl
Phase 3  Manual-input app   thin RN app: enter soil values → costed crop+fertiliser advice
   (client)                 → FIRST end-to-end demo, NO hardware needed
Phase 4  Hardware loop      firmware fixes (temp logging + GPS) + BLE ingest + offline queue
                            → real probe reading flows device → phone → backend → advice
Phase 5  Geospatial         GPS-driven field clustering (DBSCAN), boundary, area, field map
Phase 6  Pilot hardening    monitoring, feedback capture, sensor↔lab calibration, retraining
                            → FIELD PILOT in Chambal  ← this is the v1 / MVP finish line
Phase 7+ Advanced AI        yield prediction, disease vision, advisory chatbot, personalisation
```

### 2.2 Dependency graph

```
                 ┌─────────────────┐
                 │ P0 Foundations  │
                 └───────┬─────────┘
          ┌──────────────┼───────────────┐
          ▼              ▼                ▼
   ┌────────────┐  ┌───────────┐   (firmware fixes:
   │ P1 AI model│  │ P2 Backend│    temp-logging, GPS —
   └─────┬──────┘  │  + DB +   │    can proceed anytime
         │         │  agronomy │    after P0, needed by P4)
         └────────►│  engine   │
                   └─────┬─────┘
                         ▼
                   ┌───────────┐
                   │ P3 Manual │  ← first demo (client depends on P2 API contract)
                   │  app flow │
                   └─────┬─────┘
                         ▼
                   ┌───────────┐   requires firmware temp+GPS fixes
                   │ P4 HW loop│◄── + BLE frame schema frozen
                   └─────┬─────┘
                         ▼
                   ┌───────────┐
                   │ P5 Geo    │  (needs real GPS from P4)
                   └─────┬─────┘
                         ▼
                   ┌───────────┐
                   │ P6 Pilot  │  = MVP
                   └───────────┘
```

**Critical path to MVP:** P0 → P2 → P3 → P4 → P5 → P6. P1 (AI) runs alongside P2 and must be done before P2's inference service is meaningful, but it does not block P0 or the backend scaffolding. Firmware fixes are on the critical path *at P4* — start them early even though they aren't "server" work, because they gate the hardware loop.

### 2.3 Server ↔ client synchronisation points

The two repos are developed by the same person but must stay contract-driven so the app is never guessing:

| Sync point | Phase | Artifact that is the contract | Frozen when |
|---|---|---|---|
| **Auth flow** | P2 | JWT scheme + `/auth/*` endpoints | Before app login screen is built |
| **REST API shape** | P2 | `openapi.yaml` (generated) → typed client | Before P3 app data layer |
| **Recommendation payload** | P2 | `RecommendationResult` schema (Segment A/B, costed fertiliser) | Before P3 results screen |
| **BLE reading frame** | P4 | `docs/ble-protocol.md` (byte/field layout the stick emits) | Before P4 BLE parser |
| **Sync/queue protocol** | P4 | idempotency keys + `/sync` batch endpoint | Before offline queue work |

Rule: **the server owns every contract.** The client generates types from the server's OpenAPI spec; it never hand-writes a payload shape. This keeps a solo builder honest across two repos.

---

## 3. Backend architecture

### 3.1 Component view

Aaroh's backend is a small, deliberately boring service mesh: a Node API gateway for product/CRUD/auth, a Python service for anything numeric (ML + agronomy), one relational database with geospatial powers, and object storage for model artifacts.

```
                         ┌──────────────────────────────┐
   React Native app ───► │  Node/Express API (BFF)       │
   (BLE, offline queue)  │  auth, CRUD, sync, validation │
                         │  owns the product contract    │
                         └───────┬───────────────┬───────┘
                                 │ SQL           │ internal HTTP (JSON)
                                 ▼               ▼
                    ┌────────────────────┐  ┌───────────────────────────┐
                    │ PostgreSQL + PostGIS│  │ Python AI service (FastAPI)│
                    │ farmers, fields,    │  │  /predict  crop ranker     │
                    │ devices, readings,  │  │  /recommend crop+fertiliser│
                    │ recommendations,    │  │  agronomy engine (det.)    │
                    │ model_registry,     │  │  feature pipeline (shared) │
                    │ feedback            │  └──────────┬────────────────┘
                    └─────────┬───────────┘             │ loads
                              │                          ▼
                              │              ┌───────────────────────────┐
                              └─────────────►│ Model store (object storage│
                             reads model     │ /S3-compatible or volume): │
                             metadata        │  model .json/.onnx + meta  │
                                             └───────────────────────────┘
   External data providers (called by the Python service, cached in DB):
     • SoilGrids (bulk density) • Weather API (rainfall, humidity, temp)
     • ICAR-STCR equations & regional price table (config, versioned)
```

### 3.2 Why this split [load-bearing]

- **Node for the product surface.** Express (or NestJS if you want structure — see 3.4) is the best-supported ecosystem for auth, request validation, file uploads, and the offline-sync endpoints the app needs. It owns the OpenAPI contract.
- **Python for the numbers.** The ML stack (scikit-learn, XGBoost/LightGBM, pandas, numpy) and the agronomy maths live where the data-science tooling is native. Re-implementing the feature pipeline or the oxide conversions in JavaScript would duplicate load-bearing logic in a second language — exactly the kind of drift that produces unit bugs.
- **One database.** PostgreSQL + PostGIS covers relational data *and* geospatial (DBSCAN clustering, convex-hull boundaries, area) in a single engine. No separate geo store.
- **Internal HTTP, not a message bus (for now). [default]** At pilot scale the Node→Python call is a synchronous JSON request over the private network. A queue (BullMQ/Redis) is introduced only for **retraining** and **batch** jobs, not for the request path. Escape hatch: if latency or load ever demands it, the same FastAPI endpoints can sit behind a queue without changing their contract.

### 3.3 Request flows

**A) Get a recommendation (the money path):**

```
app → POST /v1/fields/:id/recommendations         (Node)
  Node: authorise, load field + latest reading + region config from Postgres
  Node → POST ai:/recommend  { features..., region, area_ha }   (Python)
     Python: feature pipeline → crop ranker → soft-ranked 20 crops
             → split Segment A (grow now) / Segment B (needs fertiliser)
             → agronomy engine: nutrient gap → product kg/bags → cost
     Python → returns RecommendationResult
  Node: persist recommendation (audit), return to app
app: render ranked crops + costed fertiliser cards
```

**B) Ingest a probe reading (Phase 4+):**

```
app (online or replaying offline queue) → POST /v1/readings (batch, idempotent)
  Node: validate against BLE-frame-derived schema, dedupe by idempotency key,
        store raw reading (unit-suffixed columns), attach to device + field
  → returns accepted/duplicate per item
```

### 3.4 Framework choice for the Node layer

- **[default] Express + a light structure** (routers per resource, a service layer, `zod` for validation) if you want minimum ceremony and maximum familiarity.
- **NestJS** if you prefer opinionated modules, dependency injection, and first-class OpenAPI generation out of the box — helpful for a solo builder because the structure enforces itself.

Recommendation for this project: **NestJS**. The built-in module boundaries, `class-validator` DTOs, and automatic Swagger/OpenAPI generation directly serve the "server owns the contract" rule and save you from re-litigating structure decisions later. If you already have strong Express muscle memory and want speed now, Express is a defensible choice — the rest of this guide is framework-neutral.

---

## 4. Repository & folder structure

The `aaroh-server` repo houses **two runtimes** (Node + Python) plus shared infra. Keep them in one repo (a lightweight monorepo) so a single commit can change an API contract and the model that serves it together — critical for a solo builder.

```
aaroh-server/
├── README.md
├── docker-compose.yml            # local: postgres+postgis, node, python, (redis later)
├── .env.example                  # every env var documented, no secrets committed
├── .github/workflows/            # CI: lint, test, build, migrate-check
│
├── api/                          # ── Node/NestJS API gateway (the product surface) ──
│   ├── src/
│   │   ├── main.ts
│   │   ├── modules/
│   │   │   ├── auth/             # JWT, OTP login, guards, RBAC
│   │   │   ├── farmers/
│   │   │   ├── fields/           # PostGIS geometry lives here
│   │   │   ├── devices/          # probe registry, pairing tokens
│   │   │   ├── readings/         # ingest + batch sync (idempotent)
│   │   │   ├── recommendations/  # calls the Python service, persists results
│   │   │   ├── feedback/         # farmer outcomes → retraining signal
│   │   │   └── ai-gateway/       # typed client to the Python service
│   │   ├── common/               # zod/class-validator DTOs, error filter, logging
│   │   └── config/               # env schema, region config loader
│   ├── test/                     # unit + e2e (supertest)
│   └── openapi.yaml              # GENERATED — the client's source of truth
│
├── ai/                           # ── Python AI subsystem (see §9 for the deep dive) ──
│   ├── datasets/
│   │   ├── raw/                  # immutable inputs (v2 csv lands here, read-only)
│   │   ├── interim/              # cleaned, unit-normalised
│   │   ├── processed/            # model-ready feature matrices
│   │   └── external/             # SoilGrids, price tables, ICAR-STCR params (versioned)
│   ├── training/
│   │   ├── configs/              # yaml: features, hyperparams, split strategy, seed
│   │   ├── pipelines/            # preprocess → train → evaluate → register
│   │   └── train.py              # entrypoint: `python -m ai.training.train --config ...`
│   ├── models/
│   │   ├── registry/             # metadata db of trained models (or MLflow store)
│   │   └── artifacts/            # frozen models (xgb .json / .onnx) + feature spec
│   ├── evaluation/               # metrics, plots, per-crop confusion, calibration
│   ├── inference/                # FastAPI app: /predict, /recommend, /health
│   │   ├── app.py
│   │   ├── feature_pipeline.py   # SHARED with training — imported, never re-coded
│   │   └── schemas.py            # pydantic request/response contracts
│   ├── services/
│   │   ├── agronomy/             # deterministic engine (STCR, oxide conversions, cost)
│   │   ├── calibration/          # per-sensor NPK correction fits
│   │   └── external/             # SoilGrids + weather clients (cached)
│   ├── tests/                    # data tests, model tests, agronomy golden tests
│   └── pyproject.toml
│
├── database/
│   ├── migrations/               # versioned SQL (one tool: e.g. node-pg-migrate or Prisma)
│   ├── seeds/                    # region config, crop bands, price table, dev fixtures
│   └── schema.sql                # generated snapshot for reference
│
├── scripts/                      # ops: backup, restore, load-external-data, smoke-test
└── docs/
    ├── ble-protocol.md           # the stick's frame layout (frozen at P4)
    ├── api-conventions.md
    └── adr/                      # architecture decision records (why, dated)
```

### 4.1 Structure rationale

- **`ai/` mirrors the tree you sketched**, with two additions that matter in production: `services/` is split into `agronomy/`, `calibration/`, and `external/` (three genuinely different responsibilities), and `feature_pipeline.py` lives in `inference/` but is **imported by training** so there is exactly one definition of how raw values become model features. Training/serving skew is the number-one silent ML bug; this structure makes it structurally hard.
- **`datasets/` follows the raw → interim → processed → external convention** so the immutable v2 CSV is never mutated in place and every transformation is reproducible from `raw/`.
- **ADRs in `docs/adr/`** cost five minutes each and save future-you from re-deciding settled questions (e.g., "why 1.95 and not 2.0").

---

## 5. Database planning

### 5.1 Engine and tooling

- **PostgreSQL 16 + PostGIS 3.4. [load-bearing]** One engine for relational + geospatial. Enable `postgis` and `cube`/`earthdistance` is *not* needed — PostGIS covers it.
- **Migrations: one tool, forward-only, checked in.** Use `node-pg-migrate` (SQL-first, plays well with the Node layer) or Prisma Migrate if you want a typed ORM in the API. Pick one and never hand-edit the DB. CI runs `migrate up` against a throwaway DB on every PR.
- **Access pattern:** the Node layer owns writes to product tables; the Python service reads what it needs (region config, latest reading) and writes to `recommendations`/prediction logs. Keep a single connection-pool per service.

### 5.2 Core schema (v1)

Column names are **unit-suffixed by rule**. This is the schema-level enforcement of principle 1.3.

```sql
-- farmers ---------------------------------------------------------------
farmers(
  id uuid pk, phone text unique, name text, preferred_lang text,   -- 'hi' | 'en'
  region_code text default 'chambal', role text default 'farmer',  -- farmer|agent|admin
  created_at timestamptz, ...
)

-- devices (soil probes) -------------------------------------------------
devices(
  id uuid pk, serial text unique, firmware_version text,
  owner_farmer_id uuid fk, calibration_profile_id uuid fk null,     -- see calibration
  last_seen_at timestamptz
)

-- fields (PostGIS) ------------------------------------------------------
fields(
  id uuid pk, farmer_id uuid fk, name text,
  boundary geometry(Polygon, 4326) null,   -- NULL until GPS works (Phase 5)
  centroid geometry(Point, 4326) null,
  area_ha numeric null,                     -- derived; business filter only
  region_code text, created_at timestamptz
)
-- GiST index on boundary + centroid for spatial queries.

-- readings (raw probe samples) -----------------------------------------
readings(
  id uuid pk, device_id uuid fk, field_id uuid fk null,
  taken_at timestamptz,                     -- from DS3231 RTC
  location geometry(Point,4326) null,       -- NULL while firmware emits GPS:PENDING
  -- sensor-native, elemental, mass basis:
  n_mgkg numeric, p_mgkg numeric, k_mgkg numeric,
  ph numeric, ec_uscm numeric, moisture_vwc numeric, soil_temp_c numeric,
  -- provenance / trust:
  npk_is_calibrated boolean default false,
  source text,                              -- 'probe_ble' | 'manual' | 'import'
  idempotency_key text unique,              -- for offline-queue dedupe
  raw_frame text null                       -- original BLE/serial frame for audit
)

-- recommendations (audit of every advice we gave) ----------------------
recommendations(
  id uuid pk, field_id uuid fk, reading_id uuid fk null,
  model_version text,                       -- fk-ish to model_registry.version
  agronomy_version text,                    -- STCR/price table version
  region_code text, area_ha numeric,
  result jsonb,                             -- full RecommendationResult (Seg A/B + costs)
  created_at timestamptz
)

-- model_registry (what's deployed, what trained it) --------------------
model_registry(
  version text pk,                          -- e.g. 'crop-ranker@1.3.0'
  algo text, trained_at timestamptz, dataset_hash text,
  metrics jsonb,                            -- top1/top3, ndcg, kl, ece, per-crop
  artifact_uri text, feature_spec_uri text,
  is_active boolean, notes text
)

-- feedback (closes the loop, feeds retraining) -------------------------
feedback(
  id uuid pk, recommendation_id uuid fk, farmer_id uuid fk,
  chosen_crop text null, actually_planted text null,
  outcome text null,                        -- 'good'|'poor'|'failed' (season end)
  lab_test jsonb null,                      -- paired lab NPK for calibration
  created_at timestamptz
)
```

### 5.3 PostGIS specifics (Phase 5)

- **Field clustering:** raw GPS points from repeated walks are noisy. Use `ST_ClusterDBSCAN(location, eps := <~5–10 m in degrees>, minpoints := N)` to group points into fields.
- **Boundary:** `ST_ConvexHull(ST_Collect(points))` per cluster for a first boundary; upgrade to concave hull (`ST_ConcaveHull`) if convex over-claims land.
- **Area:** `ST_Area(boundary::geography)` returns m² → `/10000` for hectares. Compute **once**, store in `fields.area_ha`, and treat it purely as the post-prediction scaling factor.
- **Guard the null case:** every spatial query must tolerate `boundary IS NULL` because Phase 4 firmware may still be catching up. The app shows "field boundary pending" rather than failing.

### 5.4 Data-integrity rules

- **CHECK constraints** on plausible sensor ranges (e.g., `ph BETWEEN 3 AND 10`, `ec_uscm >= 0`) — reject impossible frames at ingest.
- **No bare nutrient columns, ever.** A migration that adds a column named `p` should fail code review. Add a lint/CI check that greps migrations for un-suffixed nutrient names.
- **Region config is data, not code:** crop suitability bands, the mg/kg→kg/ha factor, oxide constants, and the fertiliser price table live in versioned seed tables (`region_config`, `crop_band`, `price_table`) keyed by `region_code` + a `version`. Recommendations record which version they used.

---

## 6. API planning

### 6.1 Conventions

- **Versioned base path:** `/v1/...`. Breaking changes bump to `/v2`.
- **Auth:** JWT access token (short-lived) + refresh token. Farmer login is **phone + OTP** (most Chambal users won't manage passwords); agents/admins may use password + OTP.
- **Validation:** every request body is a typed DTO (`class-validator`/`zod`); reject with a consistent error envelope.
- **Error envelope:** `{ error: { code, message, details? }, requestId }` — `code` is a stable machine string (`FIELD_NOT_FOUND`), `message` is human text the app can localise by `code`.
- **Idempotency:** all ingest/sync writes accept an `Idempotency-Key` (also stored on the row) so the offline queue can retry safely.
- **OpenAPI is generated, not written** — `openapi.yaml` is emitted from the DTOs and is the client's contract.

### 6.2 Endpoint map (v1)

| Method & path | Purpose | Notes |
|---|---|---|
| `POST /v1/auth/otp/request` | Send OTP to phone | rate-limited |
| `POST /v1/auth/otp/verify` | Exchange OTP → tokens | returns role |
| `POST /v1/auth/email/register` | Create an email + password account | 201; scrypt; emails a verify code |
| `POST /v1/auth/email/login` | Email + password sign-in | uniform 401, no account enumeration |
| `POST /v1/auth/email/otp/request` | Email a code (`login` \| `email_verify`) | rate-limited per address |
| `POST /v1/auth/email/otp/verify` | Redeem an email code → tokens | `login` creates the account |
| `POST /v1/auth/password/forgot` | Email a reset code | always 200 |
| `POST /v1/auth/password/reset` | Set a new password → tokens | revokes all sessions |
| `POST /v1/auth/google` | Verify a Google ID token → tokens | RS256 + `aud` must be our client ID |
| `POST /v1/auth/refresh` | Refresh access token | rotates the refresh token |
| `POST /v1/auth/logout` | Revoke the refresh token | `all: true` = every session |
| `GET  /v1/me` | Current user + prefs (lang, region) | |
| `PATCH /v1/me` | Update name / lang / region | identity + role not patchable |
| `GET/POST /v1/fields` | List / create fields | boundary optional |
| `GET  /v1/fields/:id` | Field detail + latest reading | |
| `POST /v1/devices/pair` | Register a probe to a farmer | pairing token |
| `POST /v1/readings` | **Batch, idempotent** ingest of probe samples | offline-queue target |
| `GET  /v1/fields/:id/readings` | Reading history | paginated |
| `POST /v1/fields/:id/recommendations` | **The money endpoint** — compute advice | calls Python service |
| `GET  /v1/fields/:id/recommendations` | Past advice (audit) | |
| `POST /v1/feedback` | Farmer outcome / chosen crop / lab test | retraining signal |
| `GET  /v1/config/region/:code` | Crop bands, units, price table version | cached, offline-cacheable |
| `GET  /v1/health` | Liveness/readiness | includes AI-service reachability |

**Three doors, one session.** Every sign-in route above returns the identical envelope
`{ farmer, ...TokenBundle }`, which is what lets a new provider be added without touching the
client's session handling. A farmer holds any combination of `phone` / `email` / `google_sub`
(DB CHECK: at least one), so both `phone` and `email` are nullable on the wire.

Three invariants worth restating, because getting any of them wrong is a real vulnerability
rather than a bug:

1. **`aud` must equal our own client ID** on a Google ID token. Anyone can obtain a validly
   signed Google token — for their own app. The audience check is the only thing that makes it
   a proof of identity here.
2. **Link a Google account to an existing one only when `email_verified` is true.** A Workspace
   token can carry an email the account never proved; linking on it would be account takeover.
3. **Never reveal whether an address is registered.** Unknown-account and wrong-password
   return the same 401 with equalised timing; `password/forgot` reports success either way.

Sessions are minted in exactly one place (`issueTokens` in `auth.service.ts`). A second
implementation is how a back door gets added by accident.

### 6.3 Internal Node ↔ Python contract

This is a *private* API (never exposed to the app). Keep it small and explicit.

```
POST ai:/predict
  req:  { features: {...}, region_code }
  res:  { ranked: [{crop, score}], model_version }

POST ai:/recommend            # predict + agronomy in one call
  req:  { features: {...}, region_code, area_ha, budget_hint? }
  res:  RecommendationResult   # see 6.4

GET  ai:/health               # model loaded? feature_spec version?
```

### 6.4 The `RecommendationResult` payload [load-bearing contract]

This shape is what the app renders and what Phase 3 depends on. Freeze it early.

```jsonc
{
  "model_version": "crop-ranker@1.3.0",
  "agronomy_version": "chambal-stcr@2026.08",
  "region_code": "chambal",
  "area_ha": 1.2,
  "segment_a": [                    // grow now, no fertiliser needed
    { "crop": "Chickpea", "crop_hi": "चना", "score": 0.71, "rationale_code": "PH_OK_N_MED" }
  ],
  "segment_b": [                    // viable WITH a stated fertiliser cost
    {
      "crop": "Wheat", "crop_hi": "गेहूं", "score": 0.64,
      "fertiliser": {
        "products": [
          { "name": "Urea",  "bags_50kg": 2, "kg": 100, "supplies": "N" },
          { "name": "DAP",   "bags_50kg": 1, "kg": 50,  "supplies": "P2O5,N" }
        ],
        "nutrient_gap_kgha": { "n_kgha": 40, "p2o5_kgha": 20, "k2o_kgha": 0 },
        "cost_inr": 3450
      },
      "rationale_code": "N_LOW_ADD_UREA"
    }
  ],
  "warnings": ["NPK proxy uncalibrated for this device"]   // provenance/honesty
}
```

Notes: crops carry a Hindi label for the low-literacy UI; `rationale_code` (not free text) lets the app localise the "why"; `warnings` surfaces provenance so the app never over-claims precision.

---

## 7. AI system planning

This is the heart of the server track. Read it before touching `ai/`.

### 7.1 Framing: what problem are we actually solving?

The instinct is "crop recommendation = classification, pick the best crop." **That framing is wrong for Aaroh**, and your v2 dataset already reflects the correct one:

- The dataset ships **soft labels** — a full probability distribution over all 20 crops per row (`crop_soft_labels_v2.csv`), produced by a structural causal model: latent soil/climate factors → observable chemistry → per-crop agronomic suitability → `label ~ softmax(suitability)`. Ties stay ambiguous *on purpose*.
- The product needs a **ranked shortlist**, then a business split into **Segment A** (grow now, no fertiliser) vs **Segment B** (viable with a costed fertiliser plan) — not a single winner.

So the ML task is **crop suitability ranking** (ordinal/graded), evaluated by *top-k* quality and *distributional* fidelity, with the deterministic engine bolted on afterwards. This reframing changes everything about algorithm choice and evaluation (§7.2, §8.4).

**Feature contract at inference time** (this is exactly what the v2 generator emits, and all of it is obtainable when predicting):

| Source | Features |
|---|---|
| 7-in-1 RS-485 probe | `n_mgkg`, `p_mgkg`, `k_mgkg`, `ph`, `ec_uscm`, `moisture_vwc`, `soil_temp_c` |
| Weather API | `rainfall_mm`, `humidity_pct` |
| Soil map / user | `soil_type` (categorical), `season` (Kharif/Rabi) |

Latent variables used to *build* the data (SOM, clay, CEC, management, true ECe) are deliberately **not** features — training on them would be leakage.

### 7.2 Crop recommender — algorithm selection

**Recommendation: gradient-boosted decision trees are the primary model.** Default to **LightGBM**, keep **XGBoost** as the benchmark (it is the proven winner in the reference paper, §7.4). Deep learning is *not* the right primary choice here, and the reasons are concrete, not stylistic.

Here is the honest comparison for *this* dataset (10k rows, 11 tabular features, 20 graded classes):

| Algorithm | Fit for Aaroh | Verdict |
|---|---|---|
| **LightGBM (GBDT)** | Native categorical handling (`soil_type`, `season` without one-hot), leaf-wise growth, fast iteration on CPU, supports multiclass softprob *and* LambdaMART ranking, tiny artifact, ONNX-exportable. | **Primary [default].** Best speed/quality trade-off and the only one that cleanly supports the ranking objective the soft labels were built for. |
| **XGBoost (GBDT)** | Same family; the reference paper's top performer (99% on the clean Kaggle set); slightly more battle-tested; `multi:softprob` gives a ranked probability vector. | **Co-primary / benchmark.** Train both; keep whichever wins your eval. Interchangeable in the pipeline. |
| **Random Forest** | Robust, low-tuning, great for feature-importance sanity checks and as a baseline; consistently a notch below GBMs on this task (the paper shows RF < XGBoost). | **Baseline + explainer.** Ship only if it beats the GBMs on *your* eval (it usually won't). |
| **Decision Tree (single)** | Human-readable rules; useful to sanity-check "does the model agree with agronomy?" | **Interpretability tool only**, never the production ranker. |
| **Neural network (MLP/TabNet)** | Can learn soft labels directly via KL-divergence loss; but needs more data/tuning, overfits 10k rows, heavier to serve, harder to interpret, and rarely beats GBMs on tabular. | **Experimental track.** Justified later if the dataset grows 10–100× or you fuse image/sequence data. Not v1. |
| **k-NN** | Simple, but degrades in higher dimensions and gives no calibrated ranking; the paper's weakest performer. | **Skip** (except as a trivial baseline). |

**How the soft labels get *used* (this is the part most teams miss):**

1. **v1 baseline — softprob classifier.** Train LightGBM/XGBoost multiclass on the **hard** `crop` label with `multi:softprob`. The output probability vector is your ranking. Fast, strong, easy. Calibrate the probabilities (isotonic/Platt) so scores are meaningful for the Segment A/B threshold.
2. **v1.1 — learning-to-rank (LambdaMART).** Feed the **soft-label distribution as graded relevance** into LightGBM's `lambdarank`/XGBoost's `rank:ndcg`. This directly optimises top-k ordering — exactly what the shortlist needs — and is the natural way to consume the distribution the dataset was engineered to provide.
3. **Experimental — KL-divergence MLP.** Train a small MLP to match the soft-label distribution via KL loss. Keep as a research comparison; promote only if it clearly wins.

**Decisive reasons deep learning is not primary:** tabular data with strong feature interactions is the home turf of GBDTs (they win the vast majority of tabular benchmarks); 10k rows is small for a net but ample for trees; trees train in seconds on CPU, serve in <10 ms, export to ONNX for a cheap VM, and give you feature importances/SHAP for the "why this crop" explanations the low-literacy UI needs. Save neural nets for where they genuinely dominate — the *future* vision (disease) and NLP (chatbot) features in §7.5.

### 7.3 Fertiliser recommendation — deterministic, not ML [load-bearing]

**The honest answer to "which model performs best for fertiliser recommendation" is: no ML model — use a deterministic agronomy engine.** This is a deliberate, defensible engineering decision, not a shortcut:

- **You have no supervised target.** A fertiliser recommender would need labelled ("optimal dose → outcome") data across crops, soils, and seasons for Chambal. You don't have it. Training a classifier on someone else's fertiliser table just launders a lookup through a black box while adding error.
- **The maths is known and must be auditable.** Converting a soil-test nutrient level to a product quantity is established agronomy: **ICAR-STCR targeted-yield equations** (`Fertiliser dose = (a × Target Yield − b × Soil Test Value) / % nutrient in fertiliser`) or, as a simpler v1, soil-test Low/Medium/High class → standard regional recommendation. Farmers' money and soil health ride on this; it must be inspectable and correctable by an agronomist, which a deterministic engine is and an ML model isn't.
- **This is where the "oxide trap" and unit conversions live.** The engine is the single place that: converts sensor `*_mgkg` (elemental, mass basis) → `*_kgha` (area basis) using the **1.95** factor; converts elemental P→P₂O₅ (×2.291) and K→K₂O (×1.205); maps the nutrient gap to whole **50 kg bags** of Urea/DAP/MOP; and multiplies by `area_ha` and the regional price table for a rupee cost. One module, golden-tested, versioned.

**The correct division of labour:**

```
  ML ranker  ──►  "these crops suit this field"      (probabilistic, fuzzy OK)
  Agronomy   ──►  "here's the exact fertiliser + cost" (deterministic, exact)
  engine
```

**Where ML *may* enter fertiliser later (Phase 7+):** (a) an **economic-dose optimiser** that uses a learned yield-response curve to pick the profit-maximising dose rather than the yield-maximising one — needs multi-season trial/feedback data; (b) **learned regional correction factors** that nudge STCR coefficients from accumulated `feedback` outcomes. Both are enhancements *on top of* the deterministic core, never replacements for it.

### 7.4 Reference paper analysis — Dey, Ferdous & Ahmed (2024)

*"Machine learning based recommendation of agricultural and horticultural crop farming in India under the regime of NPK, soil pH and three climatic variables," Heliyon 10:e25112.* You provided this as a reference point; here is how it maps to Aaroh.

**What they did.** Took the public Kaggle "Crop Recommendation" dataset (2,100 rows, 21 crops = 11 agricultural + 10 horticultural), collected via the Indian Chamber of Food & Agriculture. Features: N, P, K (as *externally applied fertiliser*, kg/ha), soil pH, temperature, humidity, rainfall (7 features). They trained five models — SVM, XGBoost, Random Forest, KNN, Decision Tree — under three groupings: agricultural-only (AC), horticultural-only (HC), and combined (Co). Under-sampling for balance, 70/30 split, GridSearchCV tuning, and evaluation by accuracy, precision, recall, F1, and — commendably — AUC/ROC and confusion matrices.

**What worked well.**

- **XGBoost won decisively:** 99.09% (AC), 99.3% (HC), 98.51% (Co), AUC ≈ 1.0. Ranking was XGBoost > RF > SVM > DT/KNN. This is strong external validation for our §7.2 choice of gradient-boosted trees over KNN/SVM/DT.
- **The headline insight — separate models beat a combined model.** Mixing agricultural and horticultural crops *lowered* accuracy because agronomically similar crops collide. This is a genuinely useful finding (see "modifications" below).
- **Evaluation beyond accuracy.** Using confusion matrices + AUC exposed *which* crops get confused (black gram↔lentil↔moth bean; cotton↔maize; rice↔jute; orange↔coconut) — always agronomically adjacent pairs. That's the right way to read a crop model.

**Limitations — and they matter a lot for us.**

1. **Their "NPK" is applied *fertiliser* (kg/ha), not *soil-test* nutrients.** Aaroh's probe reads *soil* N/P/K (mg/kg). These are different physical quantities. Their model literally learns "to grow crop X, apply this much fertiliser," whereas we must learn "given the soil *has* this much, which crop fits." **Their feature semantics are not directly transferable.**
2. **The dataset is near-separable and partly synthetic.** ~99% accuracy on 2,100 rows across 21 crops is a tell: the per-crop feature distributions barely overlap. Real fields — and noisy proxy sensors — are not that clean. The number will not survive contact with a Chambal probe. (Your own v2 generator's docstring calls out exactly this "circular causality / inflated accuracy" trap and was built to avoid it.)
3. **Single-label classification, no ranking, no soft labels.** They output one crop. Aaroh needs a ranked shortlist and the Segment A/B split.
4. **No cost/economics, no purchasable-unit output.** They stop at "grow crop X."
5. **All-India, not region-specific.** No Chambal calibration; no soil_type/EC/moisture/season features.

**Is their approach suitable for us? Partially — take the algorithm, leave the paradigm.**

| Take from the paper | Leave behind |
|---|---|
| Gradient-boosted trees (XGBoost/LightGBM) as the model family | Single-label classification as the *task* |
| AUC + confusion-matrix evaluation, per-crop | Accuracy-as-headline on separable data |
| "Separate models for dissimilar groups" insight | Applied-fertiliser NPK as a feature |
| Careful hyperparameter tuning (GridSearch/Optuna) | 2,100-row public dataset as ground truth for Chambal |

**Modifications for Aaroh.**

- Keep **GBDTs**, but train for **ranking on soft labels** (§7.2), not single-label.
- Translate their "separate models" insight into our world: our 20 crops are all field/agri crops (no fruit trees), so we don't split agri/horti — instead the natural separation is **by season** (`Kharif` vs `Rabi`) and possibly by soil type. Evaluate whether **season-conditioned models or a season feature** reduce the adjacent-crop confusion they observed. Track the same confusion pairs (e.g., Moong↔Urad, Wheat↔Chickpea) explicitly.
- Use their honest confusion analysis as a **template for our evaluation report** (§8.4): don't trust a single accuracy number; inspect per-crop and per-adjacent-pair behaviour.
- Expect and *design for* lower, more honest accuracy than 99% because our data is causal and our sensor is a noisy proxy — and never present a headline accuracy to farmers.

### 7.5 Additional AI features — roadmap & recommended approaches

Sequenced by value-per-effort for Chambal, to be built **after** the P6 pilot proves the core loop:

1. **Soil-health analysis (nearest, cheapest).** Not a new model — an *interpretation layer* over existing readings: classify N/P/K/pH/EC into Low/Med/High bands, flag salinity (ECe), trend over time. Rule-based + simple stats. Ship alongside the recommender; it makes the advice legible ("your soil is low in N, slightly saline").
2. **Yield prediction.** Regression (GBDT again) mapping soil + weather + chosen crop + fertiliser plan → expected yield. **Blocked on outcome data** — bootstrap from `feedback.outcome` + public district yield stats; treat v1 as a wide-interval estimate, not a promise.
3. **Advisory chatbot (high demand, careful build).** A **RAG** assistant, not a raw LLM: retrieve from a curated, versioned agronomy knowledge base (ICAR/KVK advisories, your crop bands) + the farmer's own field data, answer in Hindi. Constrain it to retrieved facts to avoid hallucinated agronomy. Bilingual TTS for low literacy. This reuses no tabular model but leans on the same `region_config`.
4. **Disease prediction (vision, heaviest).** *Here* deep learning earns its place: a CNN / fine-tuned vision transformer on leaf images (PlantVillage + locally collected Chambal images to fight domain shift). Runs as its own model service; on-device inference (TFLite) for offline use is a stretch goal. Needs a real image-collection effort first.
5. **Personalised recommendations.** Once feedback accumulates, personalise ranking to a farmer's history, risk appetite, and past outcomes (re-rank the GBDT shortlist using feedback signals). Depends on §7.2 + a feedback volume you won't have until well into the pilot.

Sequencing rule: **soil-health (1) ships with v1; the rest are post-pilot**, and each must clear a "do we have the data to make this honest?" gate before you start.

---

## 8. AI training strategy

### 8.1 Machine learning vs deep learning — the decision

**Use classical ML (gradient-boosted trees) for every tabular task in v1** (crop ranking, later yield). **Reserve deep learning for perceptual tasks** (disease images, chatbot NLP) in Phase 7+. The rule of thumb that governs this: *tabular + tens of thousands of rows + need for interpretability and cheap CPU serving → trees; images/text/audio or millions of rows → deep nets.* Aaroh's core is squarely the former. Revisit only if the dataset grows one to two orders of magnitude or you start fusing modalities.

### 8.2 Data preprocessing workflow

The pipeline is `raw → interim → processed`, reproducible from `raw/` with a fixed seed. **Preprocessing lives in `feature_pipeline.py` and is imported by both training and inference** so there is zero train/serve skew.

1. **Ingest & validate.** Load `raw/master_crop_training_data_v2.csv` + `raw/crop_soft_labels_v2.csv`. Assert schema, dtypes, and plausible ranges; fail loudly on drift from the expected 11-feature contract.
2. **Unit normalisation [load-bearing].** Confirm every column's unit/basis and *record it in the feature spec*: `n/p/k` are `mg/kg` elemental (sensor-native); `ec` is `µS/cm` (÷1000 → dS/m for salinity logic); `moisture` is % VWC; `rainfall` mm; `humidity` %. **Do not** convert to kg/ha or oxides for the model — the ranker consumes sensor-native units; conversions belong to the agronomy engine only. Keeping the model in sensor units means production readings feed it directly with no conversion step to get wrong.
3. **Missing-data policy.** Real readings will miss `rainfall`/`humidity` (weather API down) or `soil_temp_c` (firmware gap). Decide per feature: impute from region/season climatology, or let LightGBM handle native missing values (it can). Record the policy in the config; never silently zero-fill.
4. **Categoricals.** `soil_type`, `season` → LightGBM native categorical (preferred) or one-hot for XGBoost. Persist the category vocabulary in the feature spec.
5. **Scaling.** Not needed for trees. Add a `StandardScaler` only on the experimental MLP branch.
6. **Split (see 8.3).**

### 8.3 Feature engineering & split strategy

- **Feature engineering is light for trees** — GBDTs learn interactions themselves. Add only agronomically meaningful derived features and test whether they help: `ec_dsm = ec_uscm/1000`; a coarse `ph_band` (acidic/neutral/alkaline); optionally an interaction-free `salinity_flag = ec_dsm > 2`. Resist over-engineering; every added feature must earn its place on the eval.
- **Split to avoid leakage.** A plain random split is acceptable for the synthetic v2 data, but as soon as *real* readings enter, switch to **grouped splitting by field/device** so multiple readings from one field can't sit in both train and test. Keep a **held-out season** as an out-of-time check.
- **The causal-data caveat.** Because v2 is generated by a causal model, a train/test split measures "did the model learn the agronomy encoded in the generator," not "will it work in Chambal." Treat v2 metrics as a *ceiling and a sanity check*, and gate real trust on the **field-pilot feedback** in §8.7. Say this out loud in the eval report so nobody mistakes 90%+ on v2 for field-readiness.

### 8.4 Training pipeline architecture

A single command, config-driven, fully reproducible:

```
python -m ai.training.train --config ai/training/configs/crop_ranker_v1.yaml

  1. load raw + soft labels          (datasets/raw)
  2. feature_pipeline.fit_transform  (SHARED module; persists feature_spec.json)
  3. split (grouped/seeded)
  4. train model (LightGBM/XGBoost; objective: softprob → later lambdarank)
  5. evaluate (§8.5) → evaluation/report_<version>.html + metrics.json
  6. if metrics pass gates → register in model_registry + write artifact
                              (models/artifacts/crop-ranker@X.Y.Z/)
```

- **Config is the experiment.** Everything that affects results — features, hyperparams, objective, split seed, dataset hash — is in the YAML and logged. Re-running the same config reproduces the model bit-for-bit.
- **Hyperparameter tuning:** Optuna (or GridSearch as the paper used) over a small, sensible space; log the study. Don't tune on the test set.
- **Experiment tracking:** MLflow (local file backend is fine for solo/pilot) records params, metrics, and artifact URIs. This *is* your `model_registry` backing store — don't build a bespoke one.

### 8.5 Evaluation metrics — rank quality, not just accuracy

Because the task is ranking (§7.1), the metric suite is different from the paper's:

- **Top-1 and Top-3 accuracy** — is the right crop in the shortlist? Top-3 is the product-relevant number.
- **NDCG@3 / MAP** — is the *ordering* good, using the soft labels as graded relevance? This is the primary ranking metric.
- **KL divergence** between predicted and soft-label distributions — distributional fidelity (for the softprob/MLP branches).
- **Per-crop precision/recall + confusion matrix** — replicate the paper's honesty; watch the adjacent pairs (Moong↔Urad, Wheat↔Chickpea, Bajra↔Jowar).
- **Calibration / ECE** — are the scores trustworthy enough to drive the Segment A/B threshold and the confidence shown to farmers? Calibrate (isotonic) and report reliability curves.
- **Agronomic sanity checks (golden tests).** A handful of hand-authored fields with an expert-expected top crop (e.g., "high moisture + high rainfall + alluvial + Kharif → Rice should rank top-3"). These catch nonsense that aggregate metrics hide.

**Promotion gates** (tune to reality): a new model version is registerable only if Top-3 ≥ baseline, NDCG@3 not worse, calibration ECE below a threshold, and **all golden tests pass**. Otherwise it stays unregistered.

### 8.6 Model deployment strategy

- **Artifact format:** native (`.txt`/`.json` for LightGBM/XGBoost) plus an **ONNX export** for portable, dependency-light CPU serving. Ship the model *and* its `feature_spec.json` together — the spec is part of the artifact.
- **Serving:** the FastAPI `inference/` service loads the **active** model named in `model_registry` at startup (and on a reload signal). No model file is hard-coded; the registry decides what's live.
- **Rollout:** blue/green at the service level for a solo setup — start the new version alongside, smoke-test `/health` + golden requests, then flip `is_active`. Keep the previous version one flag away for instant rollback.
- **Shadow mode (optional, powerful):** run a candidate model in parallel logging predictions without serving them, compare against the active model on live traffic before promoting.

### 8.7 Retraining strategy

Retraining is **triggered, not scheduled-for-its-own-sake**:

- **Data trigger:** enough new *labelled* rows accumulated — real readings paired with `feedback.outcome` and/or lab tests (target an initial batch, e.g., a few hundred field-verified rows).
- **Drift trigger:** input drift (feature distributions of live readings diverge from training — PSI/KS test in monitoring) or outcome drift (feedback shows degrading advice).
- **Calibration trigger:** a new per-sensor calibration batch materially shifts NPK proxy→true mapping.

Workflow: new labelled data → append to a versioned dataset → re-run the training config (bump version) → evaluate against the **same** held-out set + the golden tests + the *previous* model → promote only if it clears the gates → blue/green deploy. Every retrain is a normal, reproducible run of §8.4, never a manual notebook.

### 8.8 Versioning & monitoring

- **Version everything that can change an output:** the model (`crop-ranker@X.Y.Z`), the feature spec, the dataset (content hash), the agronomy/STCR params, and the price table. Every `recommendations` row records `model_version` + `agronomy_version` so any past advice is fully reproducible and auditable.
- **Data versioning:** DVC (or just content-hashed, immutable files in `datasets/`) so `raw/` is never mutated and any processed set traces to its raw source + code version.
- **Monitoring in production:**
  - *Prediction logging:* every `/recommend` logs features (hashed if sensitive), ranked output, model version, latency.
  - *Input drift:* periodic PSI/KS of live features vs training baseline → alert.
  - *Performance:* latency, error rate, AI-service reachability from Node's `/health`.
  - *Outcome tracking:* `feedback` closes the loop — the single most valuable signal, and the only one that tells you if the advice is actually *right* for Chambal.

---

## 9. Server-side AI architecture (deep dive)

This expands the `ai/` tree from §4 into how each part behaves in production.

### 9.1 Dataset management

- `datasets/raw/` — **immutable.** The v2 CSVs land here read-only. Nothing writes here except a deliberate, versioned data drop.
- `datasets/interim/` — cleaned + unit-verified, produced by the pipeline, disposable/reproducible.
- `datasets/processed/` — model-ready matrices + persisted `feature_spec.json`.
- `datasets/external/` — SoilGrids extracts, the ICAR-STCR coefficient tables, and the Chambal price table, each **versioned** (these change and must be traceable from a recommendation).
- DVC tracks large/derived files; git tracks code + small configs. The rule: *given a git commit + DVC hashes, any model is reproducible.*

### 9.2 Training scripts organisation

- `training/configs/*.yaml` — one file per experiment; the unit of reproducibility.
- `training/pipelines/` — composable steps (`preprocess`, `train`, `evaluate`, `register`) so retraining and first-training share code.
- `training/train.py` — thin entrypoint that wires config → pipeline. No business logic in the entrypoint.

### 9.3 Model storage & registry

- `models/artifacts/<name>@<semver>/` — the frozen model, `feature_spec.json`, `metrics.json`, and the training config that produced it, together.
- `models/registry/` — MLflow-backed metadata (params, metrics, artifact URIs, `is_active`). Mirrored into the Postgres `model_registry` table so the Node layer can read "what's live" without touching MLflow.
- Artifacts live in object storage (S3-compatible) in staging/prod; a local volume is fine for dev and the early pilot.

### 9.4 Inference / prediction APIs

- `inference/app.py` — FastAPI with `/predict`, `/recommend`, `/health`. Loads the active model + feature spec at startup; exposes a guarded `/reload` to hot-swap after a promotion.
- `inference/feature_pipeline.py` — **the shared module.** Imported by training and serving; the single definition of raw→features. Changing it forces a retrain (feature-spec version bump) — which is the correct, safe behaviour.
- `inference/schemas.py` — pydantic request/response models; the `RecommendationResult` (6.4) is defined here and is the internal contract.

### 9.5 AI service layer (agronomy, calibration, external)

- `services/agronomy/` — the **deterministic engine** (§7.3): nutrient-gap → STCR dose → oxide conversion (P₂O₅ ×2.291, K₂O ×1.205) → mg/kg→kg/ha (×1.95) → whole 50 kg bags → rupee cost via the versioned price table. Pure functions, exhaustively golden-tested. This module is where correctness is *proven*, not hoped for.
- `services/calibration/` — per-device NPK correction. Takes ~20–30 paired (sensor, lab) samples per sensor, fits a correction (linear/robust), stores a `calibration_profile`, and applies it before the ranker sees NPK. Until a device is calibrated, readings carry `npk_is_calibrated=false` and the result carries the provenance warning.
- `services/external/` — SoilGrids (bulk density for the mg/kg→kg/ha factor if you refine beyond the 1.95 default) and the weather client (rainfall/humidity/temperature to fill the non-sensor features). Both cached in Postgres with TTLs; both degrade gracefully (fall back to season climatology) so a dead weather API never blocks advice.

### 9.6 Retraining workflow (operational)

Batch job (triggered per §8.7), run via `scripts/` or a scheduled CI job / BullMQ worker: assemble new labelled data → version it → run the training config → evaluate against held-out + golden + incumbent → if gated-pass, register + blue/green deploy + flip `is_active` → archive the report. Fully re-runnable; no notebooks in the loop.

### 9.7 Logging & monitoring

- **Structured JSON logs** across Node and Python with a shared `requestId` so a recommendation can be traced end-to-end.
- **Prediction log** table/stream for every `/recommend` (features hash, output, versions, latency).
- **Metrics:** Prometheus counters/histograms (request rate, latency, errors, model version in use) → Grafana; alert on latency, error rate, drift (PSI), and AI-service unreachability.
- **Error tracking:** Sentry (or equivalent) on both runtimes.

### 9.8 Deployment architecture (AI service)

For the pilot: the FastAPI service runs as its own container next to Node and Postgres via `docker-compose` on a single modest VPS (CPU-only is fine — trees are tiny). It is **never** exposed publicly; only Node reaches it over the private network. Scale later by (a) running N stateless replicas behind a load balancer and (b) moving retraining to a queue — neither changes the request contract.

---

## 10. Development phases (server track)

Each phase has **entry criteria**, **work**, **exit / definition of done**. Phase numbers align with the master flow (§2). This is your week-to-week checklist.

### Phase 0 — Foundations

*Entry:* empty repos. *Work:*

- Monorepo layout (§4), `docker-compose.yml` (postgres+postgis, api, ai), `.env.example`.
- Choose Node framework (NestJS recommended) and Python tooling (`pyproject.toml`, `ruff`, `pytest`).
- CI: lint + type-check + test + `migrate up` on a throwaway DB, both runtimes.
- First migration (extensions `postgis`; empty baseline). ADR-0001 records the stack.

*DoD:* `docker-compose up` brings up all services; `GET /v1/health` returns 200; CI green on an empty PR.

### Phase 1 — AI trustworthiness (runs in parallel with early P2)

*Entry:* P0 done; v2 dataset present. *Work:*

- Build `feature_pipeline.py`, `training/`, and the LightGBM + XGBoost softprob baselines.
- Evaluation harness (§8.5): top-1/top-3, NDCG@3, KL, per-crop confusion, calibration, golden tests.
- MLflow tracking; register the first `crop-ranker@1.0.0` if it clears gates.
- Prototype the LambdaMART ranking branch; keep whichever wins.

*DoD:* a frozen, registered model + an HTML eval report you'd show an agronomist; golden tests pass; you can explain every confusion pair.

### Phase 2 — Backend core + inference service + agronomy engine

*Entry:* P0 done; P1 model exists. *Work:*

- Migrations for the full v1 schema (§5.2); seed `region_config`/`crop_band`/`price_table` for Chambal.
- Auth (phone+OTP, JWT, RBAC), farmers/fields/devices/readings/recommendations modules.
- FastAPI `inference/` loads the active model; implement `/predict` + `/recommend`.
- **Agronomy engine** (§7.3) with exhaustive golden tests (oxide + 1.95 + bags + cost).
- Wire Node `recommendations` module → Python `/recommend`; persist results with versions.
- Generate `openapi.yaml`.

*DoD:* `POST /v1/fields/:id/recommendations` returns a correct `RecommendationResult` end-to-end via curl, with a hand-entered reading; every fertiliser number is unit-correct and golden-tested.

### Phase 3 — Manual-input app flow (client-led; server supports)

*Entry:* P2 API frozen. *Server work:* stabilise the OpenAPI contract, add `GET /v1/config/region/:code` for offline caching, harden validation/error envelopes. *DoD:* the app (see client guide) shows costed crop+fertiliser advice from manually entered soil values — **first full demo, no hardware**.

### Phase 4 — Hardware loop

*Entry:* P3 demo works; **firmware fixes landed** (temperature logging + real GPS). *Work:*

- Freeze `docs/ble-protocol.md` from the actual stick frames.
- `POST /v1/readings` batch + idempotent ingest; `/sync` semantics for the offline queue.
- Device pairing; provenance flags; CHECK constraints on sensor ranges.
- Kick off per-sensor **calibration** capture (paired lab samples).

*DoD:* a real probe reading flows device → phone → backend → recommendation; offline readings replay without duplication.

### Phase 5 — Geospatial

*Entry:* real GPS from P4. *Work:* DBSCAN clustering of walk points → convex/concave hull boundary → area; `fields.boundary/centroid/area_ha` populated; spatial endpoints + indexes. *DoD:* a walked field renders a boundary + hectares; `area_ha` feeds quantity scaling.

### Phase 6 — Pilot hardening = MVP

*Entry:* P5 done. *Work:* monitoring/alerting (§9.7), `feedback` capture + review, sensor↔lab calibration applied, first retraining dry-run, backups/restore rehearsed, security pass (§11.5). *DoD:* a small cohort of Chambal farmers uses the full loop; feedback and outcomes are being recorded for retraining. **This is v1.**

### Phase 7+ — Advanced AI

Soil-health layer ships earlier (with v1); then yield → chatbot(RAG) → disease(CNN) → personalisation, each behind a data-readiness gate (§7.5).

---

## 11. Deployment strategy

### 11.1 Environments

- **local** (docker-compose), **staging** (mirrors prod, seeded, safe to break), **production** (the pilot). Same images across staging/prod; only config/secrets differ.

### 11.2 Packaging & runtime

- One Docker image per service (`api`, `ai`), pinned base images, multi-stage builds.
- **Pilot topology:** a single modest VPS running `api`, `ai`, and (optionally) Postgres via compose, or — recommended — **managed Postgres** (Supabase / Neon / RDS) so backups, PITR, and PostGIS upgrades aren't your problem. CPU-only; the models are tiny.

### 11.3 CI/CD

- GitHub Actions: on PR → lint, type-check, unit/integration tests, `migrate up` check, model golden tests. On merge to `main` → build images, run migrations against staging, deploy staging; manual approval → prod. Model promotion is a separate, gated job (§8.6).

### 11.4 Config, secrets, data safety

- 12-factor config; secrets in the platform's secret store (never in git). `.env.example` documents every key.
- **Backups:** automated daily DB backups + tested restore (rehearse in P6). Object-storage versioning for model artifacts.
- **Migrations** forward-only; every deploy runs them idempotently before the new image serves traffic.

### 11.5 Security baseline (pilot-appropriate)

- TLS everywhere; the AI service bound to the private network only.
- JWT with short access + rotating refresh; RBAC guards on every mutating route.
- Input validation + rate limiting on auth and ingest; parameterised SQL only.
- PII minimisation: store phone + minimal profile; hash where feasible; document data retention. Farmer data is sensitive — treat it that way from day one.

---

## 12. Testing & quality gates

- **Unit** — services, validators, the agronomy engine (the agronomy engine gets *golden tests*: fixed inputs → exact expected bags/cost; these are the highest-value tests in the codebase).
- **Integration** — API + DB (supertest against a real ephemeral Postgres/PostGIS in CI).
- **Contract** — the app consumes `openapi.yaml`; a contract test fails CI if a change breaks the client's expected shapes.
- **Data tests** — schema/range assertions on `raw/` before any training run (Great Expectations or plain asserts).
- **Model tests** — the promotion gates (§8.5) run in CI for any model change; golden agronomic cases must pass.
- **Load smoke** — a simple k6/Locust script hits `/recommend` at pilot-scale concurrency before go-live.

**Definition of done (every phase):** code + tests green in CI, migrations applied, docs/ADR updated, and the phase's demoable artifact actually demonstrated.

---

## 13. Risk register & load-bearing gaps

These are the places where "looks finished" diverges from "is finished." Each is designed-for above; repeated here so they're never forgotten.

| # | Risk / gap | Where handled | Mitigation |
|---|---|---|---|
| 1 | **Oxide trap** — sensor reports elemental P/K; fertilisers graded in P₂O₅/K₂O | `services/agronomy/` | Single conversion point (×2.291, ×1.205), golden-tested; unit-suffixed columns everywhere |
| 2 | **mg/kg→kg/ha ambiguity** (2.0 vs 1.95) | `services/agronomy/` + region config | Adopt **1.95** (BD 1.3, 15 cm) as the versioned default; record it; ADR the decision |
| 3 | **Sensor NPK is an uncalibrated proxy** | `services/calibration/` + provenance flags | Per-device correction from lab pairs; `npk_is_calibrated`; result `warnings` |
| 4 | **Firmware doesn't log temperature** | schema nullable + weather fallback | Tolerate missing `soil_temp_c`; fill from weather/climatology; fix firmware before P5 GDD work |
| 5 | **GPS = `GPS:PENDING`** | nullable geometry | All spatial code tolerates null boundary; geo features gated to P4/P5 firmware fix |
| 6 | **v2 accuracy is a ceiling, not field truth** (causal/synthetic data) | eval report + feedback loop | State it in every report; gate real trust on P6 pilot feedback; retrain on labelled field data |
| 7 | **Train/serve skew** | shared `feature_pipeline.py` | One definition, imported by both; feature-spec versioning forces retrain on change |
| 8 | **Region lock-in** | `region_code` dimension | Bands/prices/params keyed by region+version from day one |

---

## 14. Quick reference

**Key commands**
```
docker-compose up                              # full local stack
npm run migrate:up            (api)            # apply migrations
npm run test / test:e2e       (api)            # tests
python -m ai.training.train --config <yaml>    # train + evaluate + (maybe) register
pytest ai/tests                                # data/model/agronomy tests
uvicorn ai.inference.app:app                   # run inference service locally
```

**Load-bearing constants**
```
mg/kg → kg/ha   : × 1.95   (bulk density 1.3, 15 cm plough layer)   [region-versioned]
Elemental → oxide: P₂O₅ = P × 2.291 ,  K₂O = K × 1.205
Salinity        : dS/m = µS/cm ÷ 1000 ; non-saline < 2 dS/m ; ECe ≈ 4 × bulk EC
Fertiliser unit : whole 50 kg bags (Urea/DAP/MOP)
```

**Column-naming rule:** every nutrient column is unit+basis suffixed — `n_mgkg` / `p_mgkg` / `k_mgkg` (sensor, elemental) vs `n_kgha` / `p2o5_kgha` / `k2o_kgha` (converted). A bare `p` fails review.

**Definition of MVP (v1):** Phase 6 — a Chambal farmer cohort completing the full probe → phone → costed advice loop, with feedback captured for retraining.

**The two rules that prevent the worst bugs:**

1. The ML model ranks crops; the deterministic engine computes fertiliser & cost. They never merge.
2. Field size is applied only *after* prediction. It is never a model feature.

---

*End of `SERVER_DEVELOPMENT_GUIDE.md`. Companion: `CLIENT_DEVELOPMENT_GUIDE.md` in `aaroh-client`. Domain source of truth: `Aaroh_Master_Documentation.docx`.*




