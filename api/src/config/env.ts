import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

/**
 * Load `api/.env` into `process.env` before validating.
 *
 * Hand-rolled for the same reason `common/jwt.ts` hand-rolls HS256: no third-party
 * dependency. Node's own `--env-file` flag would work, but it has to be threaded through
 * every entry point (`tsx watch`, `vitest`, `node-pg-migrate`, `scripts/seed.ts`), and a
 * flag missing from one of them produces exactly the failure this function exists to
 * prevent — a setting that is present in the file and absent at runtime.
 *
 * Real environment variables always win, so container and CI settings are never
 * overwritten by a developer's local file. Values may be single- or double-quoted;
 * `export ` prefixes and `#` comments are ignored. A missing file is not an error —
 * every setting has a default.
 */
function loadDotEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!key || key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

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

  // ── Passwords (email + password sign-in) ──────────────────────────────────
  // Hashing is scrypt from node:crypto — deliberately not bcrypt/argon2, for the
  // same reason JWTs are hand-rolled: no third-party crypto dependency. scrypt is
  // memory-hard and is the only password KDF in Node's standard library.
  //
  // cost = log2(N). 15 → N=32768, roughly 100–200 ms per hash on a laptop, which
  // is the usual "slow enough to matter, fast enough to serve" band. Raising it by
  // 1 doubles both time AND memory (memory ≈ 128 · N · r bytes ≈ 128 MB at
  // cost 15, r 8) — so raise deliberately, not casually.
  //
  // Existing hashes keep working when these change: the parameters are encoded
  // in each stored hash string and read back from there on verify.
  PASSWORD_SCRYPT_COST: z.coerce.number().int().min(12).max(20).default(15),
  PASSWORD_SCRYPT_BLOCK_SIZE: z.coerce.number().int().positive().default(8), // r
  PASSWORD_SCRYPT_PARALLELISM: z.coerce.number().int().positive().default(1), // p

  // ── Google Sign-In (POST /v1/auth/google) ─────────────────────────────────
  // The **Web** OAuth client ID from Google Cloud Console. The native Android/iOS
  // SDK is configured with this same web client ID, so it is the `aud` claim of
  // every ID token we receive — which is exactly what we check here. Empty means
  // Google sign-in is not configured and the route answers 503 rather than
  // accepting unverifiable tokens.
  GOOGLE_WEB_CLIENT_ID: z.string().default(''),
  // Comma-separated extra client IDs to accept as `aud` (e.g. a standalone iOS
  // client). Normally unnecessary — leave empty.
  GOOGLE_EXTRA_AUDIENCES: z.string().default(''),
  // Google's JWKS endpoint. Overridable so tests can point at a local fixture.
  GOOGLE_JWKS_URL: z.string().url().default('https://www.googleapis.com/oauth2/v3/certs'),
  GOOGLE_JWKS_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),

  // ── Email OTP (verification, email login codes, password reset) ───────────
  // MAIL_TRANSPORT=console (the default) writes the message to the log instead of
  // sending it — the email equivalent of the SMS dev stub, so the whole flow is
  // testable with no provider account. Set 'smtp' plus the SMTP_* values to send
  // real mail.
  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('Aaroh <no-reply@aaroh.local>'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  // true → implicit TLS from the first byte (port 465). false → plain connect
  // then STARTTLS upgrade (port 587, the common case).
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  EMAIL_OTP_TTL_S: z.coerce.number().int().positive().default(600), // 10 minutes
  EMAIL_OTP_MAX_PER_HOUR: z.coerce.number().int().positive().default(5), // per address
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
