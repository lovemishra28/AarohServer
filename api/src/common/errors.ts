import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger';

/** A predictable, localisable application error (§6.1 error envelope). */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

type WithRequestId = Request & { requestId?: string };

/**
 * Loggable fields extracted from a thrown value. `message` is never empty.
 *
 * A `type` alias, deliberately not an `interface`: only object-literal type
 * aliases get an implicit index signature, so only they are assignable to the
 * logger's `Record<string, unknown>` meta parameter. As an interface this
 * cannot be passed to `logger.warn(...)` without spreading it first.
 */
export type ErrorFields = {
  message: string;
  error_code?: string;
  causes?: string[];
};

/**
 * Turn an unknown thrown value into fields worth logging.
 *
 * Written because `err instanceof Error ? err.message : String(err)` produced
 * useless output for the two most common local failures:
 *
 * 1. When Node's dual-stack "Happy Eyeballs" connect fails on *every* address —
 *    which is what happens on Windows, where `localhost` is both `::1` and
 *    `127.0.0.1` — it throws an `AggregateError`. That passes `instanceof Error`,
 *    but its `message` is `''` and the real reasons live in `.errors`. So a
 *    database that simply was not running logged `{"message":""}`.
 * 2. `fetch` rejects with the flat message `"fetch failed"` and hides the real
 *    reason in `.cause`.
 */
export function describeError(err: unknown): ErrorFields {
  if (err instanceof AggregateError) {
    const causes = err.errors.map((inner) => describeError(inner).message);
    return {
      message: err.message || causes.join(' ; ') || 'AggregateError (no sub-errors)',
      ...(causes.length > 0 ? { causes } : {}),
    };
  }

  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    // Fall back to the class name so `message` is never blank.
    const fields: ErrorFields = { message: err.message || err.name };
    if (typeof code === 'string') fields.error_code = code;

    if (err.cause !== undefined) {
      const cause = describeError(err.cause);
      fields.message = `${fields.message}: ${cause.message}`;
      fields.error_code ??= cause.error_code;
    }

    return fields;
  }

  return { message: String(err) };
}

/** Attach a requestId to every request for end-to-end tracing. */
export function requestId(req: Request, _res: Response, next: NextFunction): void {
  (req as WithRequestId).requestId = randomUUID();
  next();
}

/** 404 handler using the standard error envelope. */
export function notFound(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.path}` },
    requestId: (req as WithRequestId).requestId,
  });
}

/**
 * Central error handler. Always emits `{ error: { code, message, details? }, requestId }`.
 * Must be registered last and must keep all four arguments to be recognised by Express.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const id = (req as WithRequestId).requestId;

  if (err instanceof AppError) {
    logger.warn('handled_app_error', { code: err.code, requestId: id });
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
      requestId: id,
    });
    return;
  }

  logger.error('unhandled_error', { requestId: id, ...describeError(err) });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
    requestId: id,
  });
}
