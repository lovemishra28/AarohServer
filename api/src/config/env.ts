import { z } from 'zod';

/**
 * Environment schema. Every setting the API reads is declared and validated
 * here in exactly one place (§6.1). Fail loudly at boot if something is wrong.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Default targets the host-published database port (5433, not 5432 — see
  // docker-compose.yml). Inside compose this is overridden with db:5432.
  DATABASE_URL: z.string().url().default('postgres://aaroh:aaroh@localhost:5433/aaroh'),
  AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
