import { z } from 'zod';

/**
 * Body for POST /v1/fields/:id/recommendations (§6.2). Every field is optional —
 * an empty body is valid and means "use the best soil source this field has and
 * the default agro-climatic context". Supplied values override those defaults:
 *
 *  - `reading_id`   pin the calculation to a specific stored reading instead of
 *                   letting the server choose.
 *  - `basis`        `'latest_reading'` forces the single most recent reading.
 *                   Omitted, the server prefers the field's mean once the field
 *                   holds two or more readings — a fertiliser plan is for the whole
 *                   plot, not for the last hole the probe went into — and falls
 *                   back to the latest reading otherwise.
 *  - `area_ha`      override the field's stored area for this run (e.g. planning
 *                   a sub-plot). Costs scale linearly with area downstream.
 *  - `season`, `soil_type`, `humidity`, `rainfall`  override the provisional
 *                   context features that steer ranking only (never cost math).
 *  - `budget_hint`  optional rupee ceiling the ranker may use to prefer cheaper
 *                   crop plans; advisory, not a hard filter.
 */
export const CreateRecommendationSchema = z
  .object({
    reading_id: z.string().uuid().optional(),
    basis: z.enum(['latest_reading', 'field_average']).optional(),
    area_ha: z.number().positive().max(100_000).optional(),
    season: z.string().min(1).max(40).optional(),
    soil_type: z.string().min(1).max(60).optional(),
    humidity: z.number().min(0).max(100).optional(),
    rainfall: z.number().min(0).max(100_000).optional(),
    budget_hint: z.number().nonnegative().optional(),
  })
  .strict();

export type CreateRecommendationBody = z.infer<typeof CreateRecommendationSchema>;
