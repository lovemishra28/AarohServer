import { pingDatabase } from '../../common/db';
import { describeError } from '../../common/errors';
import { logger } from '../../common/logger';
import { env } from '../../config/env';

export interface HealthReport {
  /** 'ok' = everything reachable. 'degraded' = the API is alive but a dependency is not. */
  status: 'ok' | 'degraded';
  service: 'aaroh-api';
  version: string;
  uptime_s: number;
  dependencies: {
    database: 'up' | 'down';
    ai_service: 'up' | 'down';
  };
}

/** Ping the AI service quickly; never throws — a dead dependency is reported, not fatal. */
async function pingAiService(timeoutMs = 1500): Promise<'up' | 'down'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.AI_SERVICE_URL}/health`, { signal: controller.signal });
    if (!res.ok) {
      logger.warn('ai_ping_unhealthy', { status: res.status, url: env.AI_SERVICE_URL });
      return 'down';
    }
    return 'up';
  } catch (err) {
    // Log the reason: without this, `ai_service: "down"` gives nothing to debug.
    // An abort after `timeoutMs` surfaces here as an AbortError.
    logger.warn('ai_ping_failed', { url: env.AI_SERVICE_URL, ...describeError(err) });
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness/readiness report.
 *
 * The endpoint returns HTTP 200 as long as the API process is alive (that is
 * what liveness means). Whether the system can actually *serve* is expressed by
 * `status` and the per-dependency states in the body — so a monitor watching
 * only the HTTP code cannot mistake a broken database for a healthy system.
 * Both dependencies are probed concurrently to keep the response fast.
 */
export async function getHealth(): Promise<HealthReport> {
  const [databaseOk, aiService] = await Promise.all([pingDatabase(), pingAiService()]);
  const database = databaseOk ? 'up' : 'down';

  return {
    status: database === 'up' && aiService === 'up' ? 'ok' : 'degraded',
    service: 'aaroh-api',
    version: process.env.npm_package_version ?? '0.1.0',
    uptime_s: Math.round(process.uptime()),
    dependencies: { database, ai_service: aiService },
  };
}
