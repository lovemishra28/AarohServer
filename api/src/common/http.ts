import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { AppError } from './errors';

/**
 * Wrap an async route handler so a rejected promise is forwarded to Express's
 * error middleware. Express 4 does not catch async throws on its own, so without
 * this a failed `await` becomes an unhandled rejection instead of a clean error
 * envelope.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Validate `data` against a zod schema, returning the typed value or throwing a
 * `VALIDATION_ERROR` AppError (HTTP 400) whose `details` is the flattened issue
 * list — the single choke point every router uses so validation failures share
 * one envelope (§ api-conventions "Validation").
 */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed', 400, result.error.flatten());
  }
  return result.data;
}
