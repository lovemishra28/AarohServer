import { z } from 'zod';

/**
 * Reading validation. The numeric bounds mirror the database CHECK constraints
 * (ph 3–10, ec ≥ 0) so a bad value is rejected with a clean 400 before it ever
 * reaches Postgres. NPK are elemental mg/kg (unit-suffixed) — never oxide.
 * `idempotency_key` makes batch ingest safe to retry (§6.1).
 */
export const CreateReadingSchema = z.object({
  field_id: z.string().uuid().optional(),
  device_id: z.string().uuid().optional(),
  source: z.enum(['probe_ble', 'manual', 'import']),
  taken_at: z.string().datetime().optional(),
  n_mgkg: z.number().nonnegative().optional(),
  p_mgkg: z.number().nonnegative().optional(),
  k_mgkg: z.number().nonnegative().optional(),
  ph: z.number().min(3).max(10).optional(),
  ec_uscm: z.number().nonnegative().optional(),
  moisture_vwc: z.number().min(0).max(100).optional(),
  soil_temp_c: z.number().optional(),
  npk_is_calibrated: z.boolean().default(false),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
  raw_frame: z.string().max(10000).optional(),
});

/** Batch ingest wrapper: POST /v1/readings accepts many readings at once. */
export const BatchReadingsSchema = z.object({
  readings: z.array(CreateReadingSchema).min(1).max(500),
});

export type CreateReadingBody = z.infer<typeof CreateReadingSchema>;
export type BatchReadingsBody = z.infer<typeof BatchReadingsSchema>;
