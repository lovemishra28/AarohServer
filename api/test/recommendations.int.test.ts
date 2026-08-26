import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { closeDb, pingDatabase } from '../src/common/db';
import { env } from '../src/config/env';

/**
 * End-to-end money path (§10) as an integration test. It needs a migrated +
 * seeded database (and, for the happy path, the Python AI service) running, so
 * each test skips itself when its dependencies are down rather than failing —
 * `npm test` stays green on a laptop with nothing booted, and proves the whole
 * pipeline on a machine where `docker compose up` + migrate + seed have run.
 */

let app: ReturnType<typeof createApp>;
let token = '';
let dbReady = false;
let aiReady = false;

async function pingAi(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${env.AI_SERVICE_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Full farmer login via the dev OTP flow; returns an access token. */
async function login(): Promise<string> {
  const phone = `9${String(Date.now()).slice(-11)}`; // unique-ish, 12 digits
  await request(app).post('/v1/auth/otp/request').send({ phone });
  const verify = await request(app)
    .post('/v1/auth/otp/verify')
    .send({ phone, code: env.OTP_DEV_CODE || '000000' });
  return verify.body.access_token as string;
}

const bearer = <T extends { set(field: string, value: string): T }>(r: T): T =>
  r.set('authorization', `Bearer ${token}`);

async function createField(areaHa: number | null): Promise<string> {
  const body: Record<string, unknown> = { name: 'Test plot' };
  if (areaHa !== null) body.area_ha = areaHa;
  const res = await bearer(request(app).post('/v1/fields')).send(body);
  expect(res.status).toBe(201);
  return res.body.field.id as string;
}

beforeAll(async () => {
  dbReady = await pingDatabase().catch(() => false);
  aiReady = await pingAi();
  if (dbReady) {
    app = createApp();
    token = await login();
  }
});

afterAll(async () => {
  await closeDb();
});

describe('money path — POST /v1/fields/:id/recommendations', () => {
  it('rejects a field with no readings (422 NO_READING)', async (ctx) => {
    if (!dbReady) return ctx.skip();
    const fieldId = await createField(1);
    const res = await bearer(request(app).post(`/v1/fields/${fieldId}/recommendations`)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_READING');
  });

  it('rejects an incomplete reading and names the missing field (422)', async (ctx) => {
    if (!dbReady) return ctx.skip();
    const fieldId = await createField(1);
    // Full except potassium — the engine must refuse, not assume zero.
    await bearer(request(app).post('/v1/readings')).send({
      field_id: fieldId,
      source: 'manual',
      n_mgkg: 100,
      p_mgkg: 8,
      ph: 7.2,
      ec_uscm: 0.3,
      moisture_vwc: 20,
    });
    const res = await bearer(request(app).post(`/v1/fields/${fieldId}/recommendations`)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('READING_INCOMPLETE');
    expect(res.body.error.details.missing).toContain('k_mgkg');
  });

  it('requires an area when the field has none (422 AREA_REQUIRED)', async (ctx) => {
    if (!dbReady) return ctx.skip();
    const fieldId = await createField(null); // no area
    await bearer(request(app).post('/v1/readings')).send({
      field_id: fieldId,
      source: 'manual',
      n_mgkg: 100,
      p_mgkg: 8,
      k_mgkg: 90,
      ph: 7.2,
      ec_uscm: 0.3,
      moisture_vwc: 20,
    });
    const res = await bearer(request(app).post(`/v1/fields/${fieldId}/recommendations`)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AREA_REQUIRED');
  });

  it('returns and persists a costed RecommendationResult end-to-end', async (ctx) => {
    if (!dbReady || !aiReady) return ctx.skip(); // needs the Python service too
    const fieldId = await createField(1);
    await bearer(request(app).post('/v1/readings')).send({
      field_id: fieldId,
      source: 'manual',
      n_mgkg: 100,
      p_mgkg: 8,
      k_mgkg: 90,
      ph: 7.2,
      ec_uscm: 0.3,
      moisture_vwc: 20,
    });

    const res = await bearer(request(app).post(`/v1/fields/${fieldId}/recommendations`)).send({});
    expect(res.status).toBe(201);

    const result = res.body.recommendation.result;
    expect(typeof result.model_version).toBe('string');
    expect(typeof result.agronomy_version).toBe('string');
    expect(Array.isArray(result.segment_a)).toBe(true);
    expect(Array.isArray(result.segment_b)).toBe(true);

    // Every fertiliser plan must cost a number and buy whole 50 kg bags.
    for (const plan of result.segment_b) {
      expect(typeof plan.fertiliser.cost_inr).toBe('number');
      for (const product of plan.fertiliser.products) {
        expect(Number.isInteger(product.bags_50kg)).toBe(true);
      }
    }

    // It was persisted: the list endpoint returns it.
    const list = await bearer(request(app).get(`/v1/fields/${fieldId}/recommendations`));
    expect(list.status).toBe(200);
    expect(list.body.recommendations.length).toBeGreaterThanOrEqual(1);
  });
});
