import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '../src/common/db';
import { createApp } from '../src/app';

// An open connection pool keeps the event loop alive and hangs the test run.
afterAll(async () => {
  await closeDb();
});

describe('GET /v1/health', () => {
  it('returns 200 and reports every dependency', async () => {
    const res = await request(createApp()).get('/v1/health');

    // Liveness: 200 whenever the process is alive, even if a dependency is down.
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('aaroh-api');
    expect(typeof res.body.uptime_s).toBe('number');

    // Neither the database nor the AI service is guaranteed to be running during
    // unit tests, so assert the shape and that degradation is reported honestly
    // rather than asserting 'up'.
    expect(['ok', 'degraded']).toContain(res.body.status);
    expect(['up', 'down']).toContain(res.body.dependencies.database);
    expect(['up', 'down']).toContain(res.body.dependencies.ai_service);
  });

  it("reports 'degraded' whenever any dependency is down", async () => {
    const res = await request(createApp()).get('/v1/health');
    const { database, ai_service: aiService } = res.body.dependencies;

    // The contract that makes this endpoint trustworthy: status must never say
    // 'ok' while something it depends on is unreachable.
    if (database === 'down' || aiService === 'down') {
      expect(res.body.status).toBe('degraded');
    } else {
      expect(res.body.status).toBe('ok');
    }
  });

  it('returns a 404 error envelope for unknown routes', async () => {
    const res = await request(createApp()).get('/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body).toHaveProperty('requestId');
  });
});
