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

## Authentication providers

Three doors, one session. Every sign-in route answers the **same** envelope —
`{ farmer, access_token, refresh_token, token_type, expires_in, role }` — so the app stores a
session identically no matter how it was obtained. A farmer may hold any combination of
identifiers (`phone`, `email`, `google_sub`); a database CHECK guarantees at least one.

| Door | Routes | Needs configuring? |
|---|---|---|
| Phone + OTP | `POST /v1/auth/otp/request` → `/otp/verify` | No — dev stub logs the code |
| Email + password | `POST /v1/auth/email/register`, `/email/login` | No |
| Email one-time code | `POST /v1/auth/email/otp/request` → `/email/otp/verify` | No — `MAIL_TRANSPORT=console` |
| Forgotten password | `POST /v1/auth/password/forgot` → `/password/reset` | No |
| Google | `POST /v1/auth/google` | **Yes** — see below |

Sign-out is `POST /v1/auth/logout`, which revokes the refresh token server-side. Deleting it
from the phone is not enough on its own: the row would otherwise stay valid for its full 30 days.

Full request/response detail is in [`api/openapi.yaml`](./api/openapi.yaml).

### Where settings live

`src/config/env.ts` loads **`api/.env`** at boot (a small hand-rolled reader — no `dotenv`
dependency, for the same reason `common/jwt.ts` hand-rolls HS256) and then validates every
setting through one zod schema. Real environment variables always win over the file, so
containers and CI are never overridden by a developer's local copy.

```bash
cd api && cp .env.example .env      # PowerShell: Copy-Item .env.example .env
```

Two files, two consumers — this catches people out:

| File | Read by | Use it for |
|---|---|---|
| `api/.env` | `npm run dev` / `npm start` on your host | local development |
| `.env` (repo root) | `docker compose` variable substitution | container runs |

`docker-compose.yml` forwards `JWT_SECRET`, `GOOGLE_*`, `MAIL_*` and `SMTP_*` into the `api`
service, each falling back to its schema default, so an empty root `.env` still boots.

The boot log line `api_started` prints `auth_providers` and `mail_transport`. Check it first
when a sign-in door misbehaves: `"google": false` there means the *server* has no client ID,
which is otherwise indistinguishable on the phone from the app having none.

### Email delivery

Out of the box `MAIL_TRANSPORT=console` writes each message to the API log instead of sending
it — the email equivalent of the SMS dev stub, so the whole verification/reset flow is testable
with no provider account. Outside production the response also carries `dev_code`.

For real mail set the SMTP block in `api/.env`:

```dotenv
MAIL_TRANSPORT=smtp
MAIL_FROM=Aaroh <no-reply@yourdomain.com>
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false          # false = STARTTLS on 587; true = implicit TLS on 465
SMTP_USER=you@gmail.com
SMTP_PASS=<16-char app password>
```

With Gmail this must be an **App Password** (Google Account → Security → 2-Step Verification →
App passwords), not your account password. Credentials are never transmitted unless the
connection is encrypted first.

### "Continue with Google" — Google Cloud setup

This is the only door that needs an external account. Everything below happens at
**<https://console.cloud.google.com>**.

**1. Create or pick a project.** Top-left project selector → *New project* → name it (e.g.
`aaroh`) → *Create*, then make sure it is the selected project.

**2. Configure the consent screen.** *APIs & Services → OAuth consent screen*. Choose
**External**, fill in app name, your support email, and developer contact, then save. No
scopes need adding — the default `openid`, `email`, `profile` are what we use. While the app is
in *Testing*, only accounts you list under *Test users* can sign in, so add your own Google
account there. (Publishing is not required for the pilot; sign-in works for test users.)

**3. Create the Web application client.** *APIs & Services → Credentials → Create credentials
→ OAuth client ID*, Application type **Web application**, name it `aaroh-web`. No redirect URIs
are needed. Copy the client ID — it looks like
`1234567890-abcdefghijklmnop.apps.googleusercontent.com`.

Put that **same value in both places**:

```dotenv
# AAROH-Server/api/.env      ← created by `cp .env.example .env` in api/
GOOGLE_WEB_CLIENT_ID=1234567890-abcdefghijklmnop.apps.googleusercontent.com
```

```dotenv
# AAROH-Client/.env          ← NOT .env.example; Expo only reads .env
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=1234567890-abcdefghijklmnop.apps.googleusercontent.com
```

They must match. The server checks that the ID token's `aud` equals its own
`GOOGLE_WEB_CLIENT_ID`; a mismatch is rejected as `GOOGLE_TOKEN_INVALID`. That check is what
stops a token minted for some other app from signing someone in here — so it is deliberately
not lenient.

**4. Create the Android client too.** *Create credentials → OAuth client ID*, Application type
**Android**, package name `com.agropulse.app`, and the SHA-1 of the signing certificate:

```bash
cd AAROH-Client/android && ./gradlew signingReport    # Windows: .\gradlew signingReport
```

Use the SHA-1 under `Variant: debug` for development. You never put this client's ID in any
config — Google matches the app by package name + fingerprint, while the ID **token** it mints
is still addressed to the web client. That asymmetry surprises everyone; it is not a mistake.

**5. Build a native app and test.** Google Sign-In uses a native module, so it does **not**
work in Expo Go:

```bash
cd AAROH-Client
npx expo run:android     # after changing .env: npx expo start --clear
```

Publish the release SHA-1 as a second Android client when you ship a signed APK, otherwise
sign-in works in debug and fails in release.

Leaving `GOOGLE_WEB_CLIENT_ID` unset is safe: the button still renders, the server answers
`503 GOOGLE_NOT_CONFIGURED`, and the app shows "Google sign-in is not set up yet" rather than
failing silently.

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

Auth was widened during Phase 3 when the app's redesigned sign-in screen grew Sign Up, email,
and "Continue with Google": `farmers.phone` is now nullable alongside new `email`, `google_sub`
and `email_verified_at` columns, `otp_challenges` carries email codes as well as SMS ones, and
the server gained email/password (scrypt), email one-time codes, password reset, Google
ID-token verification, `PATCH /v1/me`, and `POST /v1/auth/logout`. Run
`npm run migrate:up` before starting the API against an existing database. Every one of those
pieces uses only `node:crypto` and `node:net`/`node:tls` — no new dependency — for the same
reason `common/jwt.ts` hand-rolls HS256. See *Authentication providers* above.

Known gaps designed around, not yet fixed (guide §13): firmware measures temperature but does not
log it; GPS still emits `GPS:PENDING`; sensor NPK is an uncalibrated EC-derived proxy, so readings
carry `npk_is_calibrated=false` and results carry a provenance warning.
