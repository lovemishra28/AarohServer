import { createApp } from './app';
import { closeDb } from './common/db';
import { describeError } from './common/errors';
import { logger } from './common/logger';
import { env } from './config/env';

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info('api_started', {
    host: env.HOST,
    port: env.PORT,
    env: env.NODE_ENV,
    ai_service_url: env.AI_SERVICE_URL,
    // Which sign-in doors are actually usable. Logged at boot because the
    // alternative is discovering it from a 503 on a phone: "Continue with Google"
    // fails identically whether the client ID is missing here or on the device,
    // and only this line distinguishes the two.
    auth_providers: {
      phone_otp: true,
      email_password: true,
      email_otp: true,
      google: env.GOOGLE_WEB_CLIENT_ID.length > 0,
    },
    mail_transport: env.MAIL_TRANSPORT,
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
