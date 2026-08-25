import { createApp } from './app';
import { logger } from './common/logger';
import { env } from './config/env';

const app = createApp();

app.listen(env.PORT, () => {
  logger.info('api_started', {
    port: env.PORT,
    env: env.NODE_ENV,
    ai_service_url: env.AI_SERVICE_URL,
  });
});
