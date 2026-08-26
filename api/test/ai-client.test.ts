import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RecommendationResult, requestRecommendation } from '../src/common/ai-client';
import { AppError } from '../src/common/errors';

const SAMPLE: RecommendationResult = {
  model_version: 'crop-ranker@1.0.0',
  agronomy_version: 'chambal-stcr@2026.08-provisional',
  region_code: 'chambal',
  area_ha: 1,
  segment_a: [{ crop: 'Wheat', crop_hi: 'गेहूँ', score: 0.9, rationale_code: 'OK' }],
  segment_b: [],
  warnings: [],
};

const PAYLOAD = {
  features: {
    N: 100,
    P: 8,
    K: 90,
    ph: 7.2,
    ec: 0.3,
    moisture: 20,
    humidity: 55,
    rainfall: 40,
    soil_type: 'alluvial',
    season: 'Rabi',
  },
  region_code: 'chambal',
  area_ha: 1,
  npk_is_calibrated: false,
};

function mockFetch(impl: () => Promise<unknown> | unknown): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestRecommendation (AI gateway)', () => {
  it('returns the parsed RecommendationResult on 200', async () => {
    mockFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify(SAMPLE) }));
    const result = await requestRecommendation(PAYLOAD);
    expect(result.model_version).toBe('crop-ranker@1.0.0');
    expect(result.segment_a[0].crop).toBe('Wheat');
  });

  it('maps a non-2xx upstream response to AI_SERVICE_ERROR (502)', async () => {
    mockFetch(() => ({ ok: false, status: 500, text: async () => 'upstream boom' }));
    await expect(requestRecommendation(PAYLOAD)).rejects.toMatchObject({
      code: 'AI_SERVICE_ERROR',
      status: 502,
    });
  });

  it('maps an aborted request (our timeout) to AI_TIMEOUT (504)', async () => {
    mockFetch(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    const err = await requestRecommendation(PAYLOAD).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(504);
    expect((err as AppError).code).toBe('AI_TIMEOUT');
  });

  it('maps a connect failure to AI_UNREACHABLE (503)', async () => {
    mockFetch(() => Promise.reject(new Error('fetch failed')));
    await expect(requestRecommendation(PAYLOAD)).rejects.toMatchObject({
      code: 'AI_UNREACHABLE',
      status: 503,
    });
  });
});
