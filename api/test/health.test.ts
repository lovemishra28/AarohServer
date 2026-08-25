import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

describe('GET /v1/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(createApp()).get('/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('aaroh-api');
    // The AI service is not running during unit tests; it must still report gracefully.
    expect(['up', 'down']).toContain(res.body.dependencies.ai_service);
  });

  it('returns a 404 error envelope for unknown routes', async () => {
    const res = await request(createApp()).get('/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body).toHaveProperty('requestId');
  });
});
