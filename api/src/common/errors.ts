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

  logger.error('unhandled_error', {
    requestId: id,
    message: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
    requestId: id,
  });
}
