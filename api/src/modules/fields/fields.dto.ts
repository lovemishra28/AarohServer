import { z } from 'zod';

/**
 * Field validation. v1 fields carry a name, an optional positive area (hectares,
 * used by the recommendation money path), and a region. Boundary/centroid
 * geometry is deferred until the GPS gap is closed (firmware writes GPS:PENDING),
 * so it is not accepted here yet.
 */
export const CreateFieldSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  area_ha: z.number().positive().max(100000).optional(),
  region_code: z.string().trim().min(1).max(40).default('chambal'),
});

export type CreateFieldBody = z.infer<typeof CreateFieldSchema>;
