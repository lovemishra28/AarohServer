import { z } from 'zod';

/**
 * Request/response validation for the auth routes. Phone numbers are accepted as
 * 10–15 digits with an optional leading '+', trimmed of surrounding whitespace;
 * they are stored verbatim (no country-code inference in v1).
 */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?\d{10,15}$/, 'phone must be 10–15 digits, optionally starting with +');

export const OtpRequestSchema = z.object({
  phone: PhoneSchema,
});

export const OtpVerifySchema = z.object({
  phone: PhoneSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'code must be 4–8 digits'),
});

export const RefreshSchema = z.object({
  refresh_token: z.string().min(10),
});

export type OtpRequestBody = z.infer<typeof OtpRequestSchema>;
export type OtpVerifyBody = z.infer<typeof OtpVerifySchema>;
export type RefreshBody = z.infer<typeof RefreshSchema>;
