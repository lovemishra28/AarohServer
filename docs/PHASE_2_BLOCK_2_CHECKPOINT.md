# Phase 2 — Block 2 Checkpoint & Phase 2 Completion: Node API, Postgres, Auth, Money Path

**Date:** 2026-08-26
**Scope of this block:** full v1 database schema + migrations → seed from the canonical agronomy JSON → JWT/RBAC auth with a dev OTP stub → the Express resource modules (farmers, devices, fields, readings) → the Node→Python AI gateway → **the money path** (`POST /v1/fields/:id/recommendations`) → config + feedback endpoints → `openapi.yaml` → the Node test suite.
**Status:** Built. **Type-checked and linted clean in my sandbox; the database, test-runner, and curl end-to-end must be run on your machine to formally close the DoD.** Stopping here for your review and sign-off.

> **Read this first — same rule as Block 1: the code is real, but only *some* checks ran here.**
> `tsc --noEmit` and `eslint .` were **actually executed** in my sandbox and both exit 0 — those passes are genuine. But the box has **no PostgreSQL, no network, and a Windows `node_modules`**, so `vitest`, `node-pg-migrate`, the seed script, and the curl money path **could not be run here** (the test-runner can't even start — its Linux `rollup` binary is missing and I can't `npm i` it offline). **Please run the real `npm run typecheck && npm run lint && npm test`, the migrations, the seed, and the curl flow on your Windows machine** (commands in §6) and paste the output — that is the authoritative pass, not mine.

---

## 1. Definition of Done (SERVER_DEVELOPMENT_GUIDE §10)

> `POST /v1/fields/:id/recommendations` returns a correct `RecommendationResult` end-to-end via curl, with a hand-entered reading; every fertiliser number unit-correct and golden-tested.

Block 1 delivered everything *behind* the route (engine, model, `RecommendationResult`, golden numbers). **Block 2 wires it to HTTP + Postgres**: the route now exists, authenticates the caller, loads the field's reading, calls the Python service, persists the result, and returns it. The only thing between you and a formally-closed DoD is running the stack (§6) — the code path is complete and compiles.

---

## 2. What was built

**Database (`database/migrations/`, forward-only, `node --check` clean):**
- `..._core-schema.js` — the 7 core tables: `farmers`, `devices`, `fields`, `readings`, `recommendations`, `model_registry`, `feedback`. UUID PKs via `gen_random_uuid()`, PostGIS geometry on fields/readings, and CHECK constraints that reject a garbage reading at the storage layer (`ph` 3–10, `ec_uscm` ≥ 0, `area_ha` > 0). Nutrient columns are unit-suffixed `n_mgkg`/`p_mgkg`/`k_mgkg` (elemental) — there is no bare `p`, so the oxide trap can't reappear.
- `..._region-config.js` — `region_config`, `crop_band`, `price_table`, mirroring the canonical JSON exactly, with a partial unique index guaranteeing **one active version per region**.
- `..._auth.js` — `otp_challenges` and `refresh_tokens` (stored as SHA-256 hashes).

**Seed (`api/scripts/seed.ts`):** reads `manifest.json` + the active `{version}.json` from the Python service's region directory, validates it with zod, and upserts `region_config` / `crop_band` / `price_table` in one transaction. **One source of truth** — the API never re-types the numbers; it reads the same file the engine does.

**Auth (`api/src/common/jwt.ts`, `auth-middleware.ts`, `modules/auth/`):** HS256 JWTs on `node:crypto` (no library — the sandbox/CI has no network), short-lived access tokens + rotating refresh tokens, a dev OTP stub (fixed code `000000`, rate-limited per phone), and RBAC (`farmer` / `agent` / `admin`) with a single `assertOwnership` rule reused by every resource.

**Resource modules (`api/src/modules/`):** `farmers` (`GET /v1/me`), `devices` (pair/list), `fields` (create/list/detail), `readings` (idempotent single + batch ingest). Each is a thin router → service → repo split; ownership is enforced in the service layer in exactly one place.

**Money path (`api/src/common/ai-client.ts`, `modules/recommendations/`):** the Node→Python gateway (hard timeout via `AbortController`, failures mapped to clean `AI_TIMEOUT`/`AI_UNREACHABLE`/`AI_SERVICE_ERROR` envelopes), plus the recommendations service that resolves the reading, refuses an incomplete one (`READING_INCOMPLETE` names the missing fields), builds the feature payload, calls the service, and persists the §6.4 result with the exact `model_version` + `agronomy_version` that produced it.

**Config + feedback:** `GET /v1/config/region/:code` (read-only view of the seeded agronomy data so the app never hard-codes prices) and `POST /v1/feedback` (the ground-truth loop, attributed to the field's owner).

**Contract:** `api/openapi.yaml` — the full v1 surface (14 paths, 17 schemas), validated for well-formedness and no dangling `$ref`s. `api/.env.example` documents every setting.

**Tests (`api/test/`, authored to pass under `vitest` on your machine):** `jwt`, `auth-middleware` (RBAC/ownership), `dto` (validation bounds), and `ai-client` (mocked `fetch` — success + every error mapping) are pure unit tests. `recommendations.int.test.ts` is a DB-guarded end-to-end that exercises the real money path via supertest and **skips itself** when Postgres/the AI service aren't up, so `npm test` stays green on a bare laptop and proves the pipeline on a provisioned one.

---

## 3. The v1 API surface (all mounted under `/v1`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | public | liveness + dependency status |
| POST | `/auth/otp/request` | public | issue a login code (dev stub) |
| POST | `/auth/otp/verify` | public | code → tokens (creates farmer on first login) |
| POST | `/auth/refresh` | public | rotate refresh token |
| GET | `/me` | farmer | authenticated profile |
| POST | `/devices/pair` · GET `/devices` | farmer | claim / list probes |
| GET·POST | `/fields` · GET `/fields/:id` | farmer | manage fields |
| GET | `/fields/:id/readings` | farmer | field readings |
| POST | `/readings` | farmer | ingest reading(s), idempotent |
| **POST** | **`/fields/:id/recommendations`** | **farmer** | **money path — costed advice** |
| GET | `/fields/:id/recommendations` | farmer | saved recommendations |
| GET | `/config/region/:code` | farmer | active agronomy config |
| POST | `/feedback` | farmer | record outcome |

---

## 4. Test & lint status

| Check | Where it ran | Result |
|---|---|---|
| `tsc --noEmit` | **my sandbox (real)** | **exit 0** |
| `eslint .` | **my sandbox (real)** | **exit 0** |
| migration files `node --check` | my sandbox (real) | OK |
| `openapi.yaml` parse + ref check | my sandbox (real) | OK — 14 paths, 17 schemas, no dangling refs |
| `vitest run` | **could not run here** | Linux `rollup` binary missing, network blocked → **run on your machine** |
| `node-pg-migrate up` | could not run here | no PostgreSQL in sandbox → run on your machine |
| `seed` + curl money path | could not run here | needs DB + AI service → run on your machine |

---

## 5. Why the runtime checks are deferred (not skipped)

The sandbox has a **Windows** `node_modules` (that's how your machine is set up), **no network** (so I can't install the Linux-native binaries `vitest`/`tsx` need), and **no Postgres**. `tsc` and `eslint` are pure JS and run fine; `vitest` and `tsx` shell out to platform-native binaries and fail to even start. This is the same split you saw in Block 1 with `pytest`/`ruff`. The tests, migrations, and seed are written and compile; they just need a real runtime — yours.

---

## 6. Verification steps — please run these and paste the output

Runs the way you verified Block 1: **tools on your machine, database in Docker.** Bring up only `db` + `ai` in Docker and run the API on the host (avoids a port clash on 3000).

```bash
# ── Terminal 1: datastore + AI service ─────────────────────────────
cd AAROH-Server
docker compose up --build db ai
# db  → localhost:5433 (Postgres 16 + PostGIS)
# ai  → localhost:8000  (must serve the active model from Block 1)

# ── Terminal 2: the API (host) ─────────────────────────────────────
cd AAROH-Server/api
copy .env.example .env         # optional — defaults already target 5433 / 8000
npm install                    # if not already done
npm run typecheck              # tsc --noEmit  → expect clean (matches my run)
npm run lint                   # eslint .      → expect clean (matches my run)
npm run migrate:up             # apply the v1 schema
npm run seed                   # seed Chambal region config from the canonical JSON
npm test                       # vitest: unit green; the integration test now runs (DB+AI up)
npm run dev                    # start the API on http://localhost:3000
```

```bash
# ── Terminal 3: the money path via curl (THE DoD) ──────────────────
BASE=http://localhost:3000
PHONE=9990001234

# 1) login (dev OTP code is 000000) → capture the access token
curl -s $BASE/v1/auth/otp/request -H 'content-type: application/json' -d "{\"phone\":\"$PHONE\"}"
TOKEN=$(curl -s $BASE/v1/auth/otp/verify -H 'content-type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"code\":\"000000\"}" | jq -r .access_token)

# 2) create a 1 ha field
FIELD=$(curl -s $BASE/v1/fields -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Test plot","area_ha":1.0}' | jq -r .field.id)

# 3) enter a hand-typed reading (elemental mg/kg)
curl -s $BASE/v1/readings -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"field_id\":\"$FIELD\",\"source\":\"manual\",\"n_mgkg\":100,\"p_mgkg\":8,\"k_mgkg\":90,\"ph\":7.2,\"ec_uscm\":0.3,\"moisture_vwc\":20}"

# 4) THE MONEY PATH — costed crop + fertiliser advice
curl -s $BASE/v1/fields/$FIELD/recommendations -X POST \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' | jq .
```

`jq` is only for pretty-printing — omit it if you don't have it. In **native PowerShell** use `Invoke-RestMethod` instead of curl (the Git Bash that ships with Git for Windows runs the block above as-is).

**Expected:** step 4 returns `201` with a `recommendation.result` containing `model_version`, `agronomy_version`, `segment_a` (grow-now crops), and `segment_b` (each with a `fertiliser` plan in whole 50 kg bags and a `cost_inr`). Re-running `GET /v1/fields/$FIELD/recommendations` shows it was persisted. If the AI service isn't reachable you'll get a clean `503 AI_UNREACHABLE` rather than a crash.

> **Note on the AI container:** the `ai` service must have Block 1's active model (`crop-ranker@1.0.0`) available. If the image doesn't carry the artifact, run the AI service on the host the way you did in Block 1 (uvicorn) and point `AI_SERVICE_URL` at it — the money path only needs `http://localhost:8000/recommend` to answer.

---

## 7. Where we are

**Achieved (Phase 2, both blocks).** The complete backend core is built: the AI trustworthiness pipeline and deterministic agronomy engine (Block 1, verified on your machine — ruff clean, 80 pytest passing, `crop-ranker@1.0.0` active), and now (Block 2) the full v1 Postgres schema, phone-OTP auth with RBAC, every resource endpoint, the private Node→Python gateway, the persisted money path, config + feedback, an OpenAPI contract, and a test suite. It type-checks and lints clean.

**What can be performed right now (once you run §6).** A farmer can log in by phone, register a field, pair a probe, enter or ingest a soil reading, and receive **costed crop + fertiliser advice in purchasable 50 kg bags and rupees** — the same golden-tested numbers from Block 1, now delivered over authenticated HTTP and saved for later. Every recommendation is stamped with the model and agronomy versions that produced it, and feedback can be recorded against it. This is the first fully working slice of the product, end to end, minus the app UI and hardware.

**Next steps.**
1. **You:** run §6 and paste the output so we formally close the DoD. If green, Phase 2 is done.
2. **Provisional data sign-off (carried from Block 1, still open):** the per-crop RDF table, the six modelling choices (class multipliers, legume starter-N, thresholds, prices, 50 kg bag notional, rounding). Nothing downstream is trustworthy for a real farmer until you validate these against Chambal/MP figures.
3. **Phase 3 (next phase):** the manual-input app flow — a React Native screen that walks the OTP login, field creation, hand-entered reading, and the recommendation result. First demo with no hardware.
4. **Known gaps designed around (guide §13), still open:** firmware temperature not logged, `GPS:PENDING`, uncalibrated NPK proxy (readings already carry `npk_is_calibrated=false` and results a provenance warning).

---

## 8. One decision for you

Auth is phone-OTP only right now (farmers). Agents/admins have a `password_hash` column and the RBAC plumbing, but **no password login route exists yet** — I deferred it because the app flow is farmer-first and no agent console is in scope until later. Say the word if you want the agent/admin credential login added now rather than in the phase that needs it.
