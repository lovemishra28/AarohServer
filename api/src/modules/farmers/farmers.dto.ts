import { z } from 'zod';

/**
 * PATCH /v1/me body. Every field optional — the client sends only what changed
 * (the phone sign-up flow, for instance, sends just `name` right after verifying
 * an OTP, because the verify call itself carries no name field).
 *
 * `.strict()` rejects unknown keys so a client typo fails loudly instead of
 * silently doing nothing, and `.refine` rejects an entirely empty patch, which is
 * always a client bug rather than a no-op worth honouring.
 *
 * Note what is deliberately absent: email, phone, google_sub, role. Identity and
 * privilege are never editable through a profile patch — changing them has to go
 * through a flow that proves control of the new identifier.
 */
export const UpdateMeSchema = z
  .object({
    name: z.string().trim().min(2, 'name is too short').max(120, 'name is too long').optional(),
    preferred_lang: z.enum(['hi', 'en']).optional(),
    region_code: z.string().trim().min(2).max(40).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be provided');

export type UpdateMeBody = z.infer<typeof UpdateMeSchema>;
