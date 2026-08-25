import express, { type Express } from 'express';
import { errorHandler, notFound, requestId } from './common/errors';
import { healthRouter } from './modules/health/health.router';

/**
 * Build the Express app. Exported as a factory so tests can exercise it
 * without binding a real port. New resource routers mount under /v1 here.
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());
  app.use(requestId);

  // ── Versioned API surface (§6.1) ──
  app.use('/v1/health', healthRouter);

  // 404 + centralised error envelope must be registered last.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
