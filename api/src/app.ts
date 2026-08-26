import express, { type Express } from 'express';
import { errorHandler, notFound, requestId } from './common/errors';
import { authRouter } from './modules/auth/auth.router';
import { configRouter } from './modules/config/config.router';
import { devicesRouter } from './modules/devices/devices.router';
import { meRouter } from './modules/farmers/farmers.router';
import { feedbackRouter } from './modules/feedback/feedback.router';
import { fieldsRouter } from './modules/fields/fields.router';
import { healthRouter } from './modules/health/health.router';
import { readingsRouter } from './modules/readings/readings.router';

/**
 * Build the Express app. Exported as a factory so tests can exercise it
 * without binding a real port. All resource routers mount under /v1 here; each
 * router owns its own authentication (health and auth are the only public
 * surfaces — everything else authenticates inside the router).
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());
  app.use(requestId);

  // ── Versioned API surface (§6.1, §6.2) ──
  app.use('/v1/health', healthRouter);
  app.use('/v1/auth', authRouter);
  app.use('/v1/me', meRouter);
  app.use('/v1/devices', devicesRouter);
  app.use('/v1/fields', fieldsRouter);
  app.use('/v1/readings', readingsRouter);
  app.use('/v1/config', configRouter);
  app.use('/v1/feedback', feedbackRouter);

  // 404 + centralised error envelope must be registered last.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
