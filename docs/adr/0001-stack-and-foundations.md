# ADR-0001: Server stack & Phase 0 foundations

- **Status:** Accepted
- **Date:** 2026-08-26
- **Deciders:** mishr (solo/lead builder)

## Context

Aaroh's off-device system must serve two clients (the soil probe and the
mobile/web app), run an ML crop-ranker plus a deterministic agronomy engine,
and store relational + geospatial data. We are starting greenfield and want a
foundation that is reproducible, easy to share with future collaborators, and
cheap to run for a pilot.

## Decision

**Monorepo** containing two runtimes plus shared infra:

| Concern | Choice | Notes |
|---|---|---|
| API / product surface | **Node + Express** (TypeScript) | Chosen over the guide's NestJS suggestion for familiarity and minimal ceremony. Structured with per-resource routers + a service layer + `zod` validation. |
| AI / numeric work | **Python + FastAPI** | Native home for the ML + agronomy maths. Runs as a private service Node calls over internal HTTP. |
| Database | **PostgreSQL 16 + PostGIS 3.4** | One engine for relational *and* geospatial. Runs in Docker locally; swappable to managed cloud (Neon/Supabase) via a connection string. |
| Migrations | **node-pg-migrate** | SQL-first, forward-only, checked in. Run from `./api` against `../database/migrations`. |
| Local orchestration | **docker-compose** | One command brings up db + api + ai. |
| CI | **GitHub Actions** | Lint, type-check, test both runtimes + a migrate-up check against a throwaway Postgres. |

## Why database location is a config value, not code

The database is referenced only through a `DATABASE_URL` connection string held
in `.env`. Local development points it at the Docker `db` service; production
points it at a managed cloud database. No code changes are required to move
between them — this keeps the door open to hosting the DB "on the internet"
and to sharing one database across collaborators.

## Consequences

- A new contributor's setup is: install Docker + Git, clone, `docker compose up`.
- Because Express is unopinionated, we impose our own structure conventions
  (see `docs/api-conventions.md`); this is the tradeoff for choosing it over NestJS.
- The Python service's Python version is pinned in its Dockerfile, independent
  of any contributor's system Python.

## Alternatives considered

- **NestJS** for the API (guide's recommendation) — more built-in structure and
  automatic OpenAPI generation, but more ceremony; deferred in favour of Express.
- **Prisma** for migrations/ORM — typed DB access, but adds abstraction over SQL;
  `node-pg-migrate` keeps migrations transparent and SQL-close.
