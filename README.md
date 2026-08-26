# Aaroh — Server

Backend and AI subsystem for **Aaroh** (आरोह, "the ascent") — a handheld soil probe plus mobile app
that gives Indian farmers specific, **costed** crop and fertiliser advice in real purchasable units
(kg and 50 kg bags of Urea / DAP / MOP), not abstract nutrient ratios.

Region v1: **Gwalior / Chambal division, Madhya Pradesh**.

This repository is everything that runs **off-device**. The firmware lives with the hardware; the
mobile app lives in `AarohClient`.

- **Technical plan:** [`SERVER_DEVELOPMENT_GUIDE.md`](./SERVER_DEVELOPMENT_GUIDE.md) — read §1 and §2 before writing code.
- **AI subsystem (the crop ranker):** [`ai/README.md`](./ai/README.md) — how to train, evaluate, and register a model.
- **Architecture decisions:** [`docs/adr/`](./docs/adr/) — [0001 stack](./docs/adr/0001-stack-and-foundations.md), [0002 feature pipeline & splits](./docs/adr/0002-feature-pipeline-and-splits.md), [0003 file model registry](./docs/adr/0003-file-model-registry.md), [0004 two engines](./docs/adr/0004-two-engines.md).
- **API structure conventions:** [`docs/api-conventions.md`](./docs/api-conventions.md)

---

## The three services

| Service | Stack | Local URL | Responsibility |
|---|---|---|---|
| `api` | Node 22 + Express + TypeScript | http://localhost:3000 | The product surface. Auth, CRUD, validation, offline sync. Owns every client-facing contract. |
| `ai` | Python 3.12 + FastAPI | http://localhost:8000 | Anything numeric: the ML crop-ranker and the deterministic agronomy engine. Private — only `api` calls it. |
| `db` | PostgreSQL 16 + PostGIS 3.4 | `localhost:5433` | Relational **and** geospatial data in one engine. |

Two rules that prevent the worst class of bug in this codebase:

1. The ML model **ranks crops**; a deterministic engine **computes fertiliser and cost**. They never merge.
2. Field size is applied only *after* prediction. It is never a model feature.

---

## Prerequisites

You only strictly need the first two — Docker runs the database, so there is **no separate database install**.

- **Docker Desktop** (provides `docker` and `docker compose`)
- **Git**
- Node.js 22+ and Python 3.11+ — optional, but recommended for running tests and migrations outside containers.

## Quick start

```bash
git clone https://github.com/lovemishra28/AarohServer.git
cd AarohServer
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
docker compose up --build
```

Then check that both services answer:

- http://localhost:3000/v1/health → `{"status":"ok","dependencies":{"database":"up","ai_service":"up"}}`
- http://localhost:8000/health → `{"status":"ok","model_loaded":false}`

The API's `status` is `"ok"` only when **every** dependency is reachable; if the database or
AI service is down it returns `"degraded"` (still HTTP 200 — the process itself is alive).
`model_loaded` is `false` until a trained crop-ranker is registered (Phase 1).

Stop with `Ctrl+C`; `docker compose down -v` also wipes the database volume.

## Database migrations

`docker compose up` does **not** run migrations — run them explicitly. They are forward-only and
checked into `database/migrations/`.

```bash
cd api
npm install
DATABASE_URL=postgres://aaroh:aaroh@localhost:5433/aaroh npm run migrate:up
```

On Windows PowerShell, set the variable first:

```powershell
cd api
npm install
$env:DATABASE_URL = "postgres://aaroh:aaroh@localhost:5433/aaroh"
npm run migrate:up
```

Create a new migration with `npm run migrate:create -- my-migration-name`.

> **Why port 5433 and not 5432?** If PostgreSQL is also installed natively on your
> machine, it already owns 5432. Windows permits *both* it and Docker's forwarder to
> listen on that port, then routes your connection to whichever bound first — usually
> the native install, which has no `aaroh` user. The symptom is a thoroughly misleading
> `password authentication failed for user "aaroh"` even though the container is fine.
> Publishing on 5433 avoids the collision. Change `DB_HOST_PORT` in `.env` if you need
> a different one. Inside the containers the port is still 5432.
>
> To confirm a collision on your machine: `netstat -ano | findstr ":5432"` — two
> `LISTENING` lines with different PIDs means two servers are competing.

> Column-naming rule, enforced in review: every nutrient column carries its unit and basis —
> `n_mgkg` / `p_mgkg` / `k_mgkg` (sensor, elemental) vs `n_kgha` / `p2o5_kgha` / `k2o_kgha`
> (converted, oxide). **A bare `p` is a bug.**

## Tests and checks

```bash
cd api && npm install && npm run lint && npm run typecheck && npm test
cd ai  && pip install -e ".[dev]" && ruff check . && pytest
```

CI (`.github/workflows/ci.yml`) runs all of the above on every pull request, plus a
`migrate:up` against a throwaway PostGIS database.

## Using a cloud database instead of local Docker

The database is referenced **only** through the `DATABASE_URL` connection string — never hardcoded.
To use a managed provider (Neon, Supabase, RDS — all support PostGIS), put its connection string in
`.env`, set the same value on the `api` service in `docker-compose.yml`, and run the migrations
against it. No code changes are required.

Note the hostname difference: from your own machine the database is at `localhost:5433`, but from
*inside* a container it is at `db:5432` (the compose service name and its internal port).

---

## Where we are

Phase numbering follows `SERVER_DEVELOPMENT_GUIDE.md` §2. Each phase ends in something demoable.

| Phase | What | Status |
|---|---|---|
| 0 | Foundations — repo, compose, CI, baseline migration | **done** |
| 1 | AI trustworthiness — train + evaluate the crop ranker | **built** |
| 2 | Backend core — full schema, auth, inference service, agronomy engine | **built** |
| 3 | Manual-input app flow — first end-to-end demo, no hardware | next |
| 4 | Hardware loop — BLE ingest, offline queue (needs firmware temp + GPS fixes) | |
| 5 | Geospatial — GPS clustering, field boundaries, area | |
| 6 | Pilot hardening — monitoring, feedback, calibration → **v1 / MVP** | |
| 7+ | Advanced AI — yield, chatbot (RAG), disease vision, personalisation | |

Phase 1 is code-complete and verified end-to-end: the training pipeline, ranking
metrics, agronomic golden tests, file registry, HTML eval report, and ONNX export
are all built and covered by a 45-test suite. Producing the actual **registered,
active model + its report** (the phase's deliverable) is one command — see
[`ai/README.md`](./ai/README.md) → *Train a model*. Activation is gated: a model
goes live only if it beats the baseline on Top-3/NDCG@3, is well-calibrated, and
passes every golden test.

Phase 2 is built: the full v1 Postgres schema + migrations, phone-OTP auth with
RBAC, every resource endpoint, the private Node→Python gateway, the persisted
money path (`POST /v1/fields/:id/recommendations`), config + feedback, and an
OpenAPI contract. It type-checks and lints clean; the database migrations, the
`vitest` suite, and the curl end-to-end run on your machine (see
[`docs/PHASE_2_BLOCK_2_CHECKPOINT.md`](./docs/PHASE_2_BLOCK_2_CHECKPOINT.md) §6)
to formally close the phase's definition of done.

Known gaps designed around, not yet fixed (guide §13): firmware measures temperature but does not
log it; GPS still emits `GPS:PENDING`; sensor NPK is an uncalibrated EC-derived proxy, so readings
carry `npk_is_calibrated=false` and results carry a provenance warning.
