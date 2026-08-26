import { z } from 'zod';

/**
 * Environment schema. Every setting the API reads is declared and validated
 * here in exactly one place (§6.1). Fail loudly at boot if something is wrong.
 *
 * TTLs are expressed in **seconds** as plain integers (not "15m" strings) so the
 * JWT layer and the database expiry timestamps use one unambiguous unit.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Default targets the host-published database port (5433, not 5432 — see
  // docker-compose.yml). Inside compose this is overridden with db:5432.
  DATABASE_URL: z.string().url().default('postgres://aaroh:aaroh@localhost:5433/aaroh'),
  AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),

  // ── AI gateway ────────────────────────────────────────────────────────────
  // The money path calls the Python /recommend synchronously; inference is
  // slower than a health ping, so this budget is larger than health's 1.5 s.
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  // ── Auth (§6.1) ─────────────────────────────────────────────────────────
  // Access tokens are HS256 JWTs signed with this secret (node:crypto, no
  // library). MUST be overridden in production; the default only keeps local dev
  // and tests running. Minimum length guards against a trivially brute-forced
  // secret sneaking into a real deployment.
  JWT_SECRET: z.string().min(16).default('dev-insecure-secret-change-me-please'),
  JWT_ACCESS_TTL_S: z.coerce.number().int().positive().default(900), // 15 minutes
  JWT_REFRESH_TTL_S: z.coerce.number().int().positive().default(2_592_000), // 30 days

  // ── OTP (dev stub — no SMS provider) ──────────────────────────────────────
  // When set, every OTP request issues this fixed code (handy for tests/curl).
  // When empty, a random 6-digit code is generated and logged.
  OTP_DEV_CODE: z.string().default('000000'),
  OTP_TTL_S: z.coerce.number().int().positive().default(300), // 5 minutes
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_MAX_PER_HOUR: z.coerce.number().int().positive().default(5), // rate limit per phone
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
