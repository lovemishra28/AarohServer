import { z } from 'zod';

/**
 * Body for POST /v1/feedback (§6.2) — the ground-truth loop. Tied to a prior
 * recommendation. At least one substantive field must be present so we never
 * store an empty feedback row. `lab_test` is free-form JSON (an independent soil
 * lab result) used later to calibrate the probe proxy.
 */
export const CreateFeedbackSchema = z
  .object({
    recommendation_id: z.string().uuid(),
    chosen_crop: z.string().min(1).max(80).optional(),
    actually_planted: z.string().min(1).max(80).optional(),
    outcome: z.string().min(1).max(2000).optional(),
    lab_test: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.chosen_crop !== undefined ||
      b.actually_planted !== undefined ||
      b.outcome !== undefined ||
      b.lab_test !== undefined,
    { message: 'Provide at least one of chosen_crop, actually_planted, outcome or lab_test.' },
  );

export type CreateFeedbackBody = z.infer<typeof CreateFeedbackSchema>;
