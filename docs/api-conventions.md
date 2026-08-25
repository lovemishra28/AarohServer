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
- `GET /v1/health` always returns 200 if the process is alive; the body reports
  dependency reachability (e.g. the AI service). Used for liveness/readiness.
