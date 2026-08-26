import { AppError, describeError } from './errors';
import { logger } from './logger';
import { env } from '../config/env';

/**
 * Client for the **private** Python inference service (§6.3) — never exposed to
 * the app. Only the recommendation money path uses it. It performs the HTTP call
 * with a hard timeout and maps every failure onto a clean error envelope; it does
 * NOT know about database columns (the service assembles `features`).
 */

/** Raw feature payload the Python `Features` model expects (§6.3). */
export interface AiFeatures {
  N: number;
  P: number;
  K: number;
  ph: number;
  ec: number;
  moisture: number;
  humidity: number;
  rainfall: number;
  soil_type: string;
  season: string;
  temperature?: number;
}

export interface RecommendPayload {
  features: AiFeatures;
  region_code: string;
  area_ha: number;
  npk_is_calibrated: boolean;
  budget_hint?: number;
}

// ── RecommendationResult (§6.4) — the frozen shape the app renders ──────────
export interface ProductLine {
  name: string;
  bags_50kg: number;
  kg: number;
  supplies: Record<string, number>;
}
export interface Fertiliser {
  products: ProductLine[];
  nutrient_gap_kgha: { n_kgha: number; p2o5_kgha: number; k2o_kgha: number };
  cost_inr: number;
}
export interface SegmentAItem {
  crop: string;
  crop_hi: string;
  score: number;
  rationale_code: string;
}
export interface SegmentBItem extends SegmentAItem {
  fertiliser: Fertiliser;
}
export interface RecommendationResult {
  model_version: string;
  agronomy_version: string;
  region_code: string;
  area_ha: number;
  segment_a: SegmentAItem[];
  segment_b: SegmentBItem[];
  warnings: string[];
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const url = `${env.AI_SERVICE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AI_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      // Upstream rejected us. Surface its status + body detail but do not leak
      // the internal URL to the caller.
      logger.error('ai_recommend_upstream_error', { status: res.status, path });
      throw new AppError('AI_SERVICE_ERROR', 'The recommendation service returned an error.', 502, {
        upstream_status: res.status,
        upstream_body: text.slice(0, 500),
      });
    }
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof AppError) throw err;
    // AbortError => our timeout fired; everything else is a connect/DNS failure.
    if (err instanceof Error && err.name === 'AbortError') {
      logger.error('ai_recommend_timeout', { path, timeout_ms: env.AI_REQUEST_TIMEOUT_MS });
      throw new AppError('AI_TIMEOUT', 'The recommendation service timed out.', 504);
    }
    logger.error('ai_recommend_unreachable', { path, ...describeError(err) });
    throw new AppError('AI_UNREACHABLE', 'The recommendation service is unreachable.', 503);
  } finally {
    clearTimeout(timer);
  }
}

/** Call Python `/recommend` and return the full RecommendationResult (§6.4). */
export async function requestRecommendation(
  payload: RecommendPayload,
): Promise<RecommendationResult> {
  return (await postJson('/recommend', payload)) as RecommendationResult;
}
