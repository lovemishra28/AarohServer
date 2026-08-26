import { createApp } from './app';
import { closeDb } from './common/db';
import { describeError } from './common/errors';
import { logger } from './common/logger';
import { env } from './config/env';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info('api_started', {
    port: env.PORT,
    env: env.NODE_ENV,
    ai_service_url: env.AI_SERVICE_URL,
  });
});

/**
 * Graceful shutdown. `docker compose down` sends SIGTERM; without this the
 * process is killed mid-request and pooled database connections are left for
 * the server to time out. Stop accepting connections, then close the pool.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('api_shutting_down', { signal });

    server.close(() => {
      void closeDb()
        .catch((err: unknown) => {
          logger.error('db_close_failed', describeError(err));
        })
        .finally(() => process.exit(0));
    });
  });
}
