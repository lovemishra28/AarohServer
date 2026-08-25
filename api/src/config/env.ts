import { z } from 'zod';

/**
 * Environment schema. Every setting the API reads is declared and validated
 * here in exactly one place (§6.1). Fail loudly at boot if something is wrong.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().default('postgres://aaroh:aaroh@localhost:5432/aaroh'),
  AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
