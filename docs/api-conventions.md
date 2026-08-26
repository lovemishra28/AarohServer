# API conventions

Because we chose Express (unopinionated), these conventions are the structure
we impose ourselves. They implement §6 of `SERVER_DEVELOPMENT_GUIDE.md`.

## Versioning
- All routes live under `/v1/...`. Breaking changes bump to `/v2`.

## Folder layout (`api/src`)
- `config/` — env schema + config loaders (validated once, at boot).
- `common/` — cross-cutting pieces: logger, error envelope, shared middleware.
- `modules/<resource>/` — one folder per resource, each with:
  - `<resource>.router.ts` — HTTP routes only; no business logic.
  - `<resource>.service.ts` — business logic; no Express types.
  - (later) `<resource>.dto.ts` — `zod` schemas for request/response validation.

## Error envelope
Every error response is:
```json
{ "error": { "code": "STABLE_CODE", "message": "human text", "details": null }, "requestId": "uuid" }
```
- `code` is a stable machine string the app localises (e.g. `FIELD_NOT_FOUND`).
- `requestId` is attached to every request and appears in logs for tracing.

## Validation
- Every request body/params is validated with `zod` before it reaches a service.
- Reject invalid input with `AppError('VALIDATION_ERROR', ..., 400, details)`.

## Health
- `GET /v1/health` always returns **HTTP 200** if the process is alive — that is
  what liveness means, and a monitor should be able to distinguish "the API is
  down" from "a dependency is down."
- Readiness lives in the **body**, not the status code:
  ```json
  {
    "status": "ok",
    "service": "aaroh-api",
    "version": "0.1.0",
    "uptime_s": 42,
    "dependencies": { "database": "up", "ai_service": "up" }
  }
  ```
- `status` is `"ok"` only when every dependency is `"up"`; otherwise `"degraded"`.
  **It must never report `ok` while something it depends on is unreachable** —
  that is the property that makes this endpoint worth having, and it is covered
  by a test. Add every new hard dependency to `dependencies`.
- Probes run concurrently and each fails fast (AI service 1.5 s, database 2 s).
  A dependency check never throws; it reports `down`.

## Logging
- One line of JSON per event, via `common/logger.ts`. Never `console.log`.
- The first argument is an **event name**: stable, snake_case, greppable
  (`api_started`, `db_ping_failed`, `unhandled_error`). Not a sentence — you
  will one day alert on this token, so it must not change wording over time.
- Everything else goes in the meta object: `logger.warn('db_ping_failed', { message: err.message })`
  →
  ```json
  {"ts":"...","level":"warn","event":"db_ping_failed","message":"connect ECONNREFUSED 127.0.0.1:5433"}
  ```
- `ts`, `level` and `event` are reserved; meta cannot overwrite them.
- **Log caught errors with `describeError(err)`** from `common/errors.ts`, never
  `err.message`. Two very common failures carry no message of their own: a
  dual-stack connect failure throws an `AggregateError` whose `message` is `''`
  (real reasons in `.errors`), and `fetch` rejects with a flat `"fetch failed"`
  (real reason in `.cause`). `describeError` unwraps both and adds `error_code`,
  so `message` is never blank.
- Include `requestId` in any log emitted while handling a request.
- Never log secrets, connection strings, or raw request bodies.

## Database access
- One shared `pg` pool, created lazily in `common/db.ts`. Never construct a
  `Pool` or `Client` anywhere else.
- The pool has an `'error'` listener by design: without one, an error on an
  *idle* client raises an uncaught exception and kills the process.
- Use `withClient()` for anything needing a dedicated connection (transactions).
- Parameterised queries only — never string-concatenate SQL.
