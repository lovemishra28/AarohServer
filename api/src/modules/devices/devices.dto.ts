import { z } from 'zod';

/** Device pairing input: the probe's serial, and optionally its firmware. */
export const PairDeviceSchema = z.object({
  serial: z.string().trim().min(3).max(120),
  firmware_version: z.string().trim().max(60).optional(),
});

export type PairDeviceBody = z.infer<typeof PairDeviceSchema>;
