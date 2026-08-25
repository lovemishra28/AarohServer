import { env } from '../../config/env';

export interface HealthReport {
  status: 'ok';
  service: 'aaroh-api';
  version: string;
  uptime_s: number;
  dependencies: {
    ai_service: 'up' | 'down';
  };
}

/** Ping the AI service quickly; never throws — a dead dependency is reported, not fatal. */
async function pingAiService(timeoutMs = 1500): Promise<'up' | 'down'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.AI_SERVICE_URL}/health`, { signal: controller.signal });
    return res.ok ? 'up' : 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness/readiness report. The endpoint returns 200 as long as the API
 * process is alive; the body reports whether dependencies are reachable.
 */
export async function getHealth(): Promise<HealthReport> {
  const aiService = await pingAiService();
  return {
    status: 'ok',
    service: 'aaroh-api',
    version: process.env.npm_package_version ?? '0.1.0',
    uptime_s: Math.round(process.uptime()),
    dependencies: { ai_service: aiService },
  };
}
