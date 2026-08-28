import { z } from 'zod';

/**
 * Request validation for the auth routes.
 *
 * Phone numbers are accepted as 10–15 digits with an optional leading '+',
 * trimmed of surrounding whitespace; they are stored verbatim (no country-code
 * inference in v1).
 *
 * The email/password and Google schemas were added in Phase 3 to match the three
 * doors the client now offers (README §5 "Authentication providers"). Note that
 * these mirror the *client's* validators (`AAROH-Client/src/lib/validators.ts`)
 * on purpose: the client validates for fast feedback, the server validates
 * because it is the only side that cannot be bypassed.
 */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?\d{10,15}$/, 'phone must be 10–15 digits, optionally starting with +');

export const OtpRequestSchema = z.object({
  phone: PhoneSchema,
});

/** Shared by phone OTP and email OTP — same shape of code, same bounds. */
export const OtpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{4,8}$/, 'code must be 4–8 digits');

export const OtpVerifySchema = z.object({
  phone: PhoneSchema,
  code: OtpCodeSchema,
});

export const RefreshSchema = z.object({
  refresh_token: z.string().min(10),
});

/**
 * Sign-out. `all` revokes every live session for the same farmer rather than just
 * the token presented — "sign out on all my devices". Defaults to false so the
 * ordinary case only ends the session on this phone.
 */
export const LogoutSchema = z.object({
  refresh_token: z.string().min(10),
  all: z.boolean().optional().default(false),
});

/* ─── Email + password ──────────────────────────────────────────────────────── */

/**
 * Emails are lower-cased here so every downstream consumer sees the canonical
 * form. The 254-character ceiling is the RFC 5321 limit on a forward path — past
 * it, the address cannot be delivered to anyway.
 */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'email is too long')
  .email('must be a valid email address');

/**
 * Password policy: 8+ characters with at least one letter and one digit —
 * identical to the client's `isValidPassword`, so the form and the API agree on
 * what "too weak" means. The 128 ceiling exists because scrypt's cost is paid on
 * *our* CPU: without an upper bound, a multi-megabyte password is a free
 * denial-of-service.
 */
export const PasswordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(128, 'password must be at most 128 characters')
  .refine((v) => /[A-Za-z]/.test(v), 'password must contain a letter')
  .refine((v) => /\d/.test(v), 'password must contain a number');

/** Names may be Devanagari or Latin; only triviality is rejected. */
export const NameSchema = z.string().trim().min(2, 'name is too short').max(120, 'name is too long');

export const EmailRegisterSchema = z.object({
  name: NameSchema,
  email: EmailSchema,
  password: PasswordSchema,
});

/**
 * Login deliberately does NOT apply PasswordSchema: a legacy or policy-changed
 * password must still be *checkable*. Rejecting it at the schema would turn
 * "your password changed policy" into "your password is invalid input".
 */
export const EmailLoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(1024),
});

/* ─── Email OTP (verification, code login, password reset) ──────────────────── */

export const EmailOtpPurposeSchema = z.enum(['login', 'email_verify']);

export const EmailOtpRequestSchema = z.object({
  email: EmailSchema,
  /** Defaults to 'login' so the common case needs no field. */
  purpose: EmailOtpPurposeSchema.default('login'),
});

export const EmailOtpVerifySchema = z.object({
  email: EmailSchema,
  code: OtpCodeSchema,
  purpose: EmailOtpPurposeSchema.default('login'),
});

export const PasswordForgotSchema = z.object({
  email: EmailSchema,
});

export const PasswordResetSchema = z.object({
  email: EmailSchema,
  code: OtpCodeSchema,
  password: PasswordSchema,
});

/* ─── Google ────────────────────────────────────────────────────────────────── */

/**
 * The ID token the native Google SDK hands the app. Only its coarse shape is
 * checked here (three dot-separated segments); the real validation — signature,
 * issuer, audience, expiry — happens in `common/google-oauth.ts`, because that is
 * cryptography, not input parsing.
 */
export const GoogleSignInSchema = z.object({
  id_token: z
    .string()
    .trim()
    .min(20)
    .max(8192)
    .regex(/^[\w-]+\.[\w-]+\.[\w-]+$/, 'id_token must be a JWT'),
});

export type OtpRequestBody = z.infer<typeof OtpRequestSchema>;
export type OtpVerifyBody = z.infer<typeof OtpVerifySchema>;
export type RefreshBody = z.infer<typeof RefreshSchema>;
export type LogoutBody = z.infer<typeof LogoutSchema>;
export type EmailRegisterBody = z.infer<typeof EmailRegisterSchema>;
export type EmailLoginBody = z.infer<typeof EmailLoginSchema>;
export type EmailOtpRequestBody = z.infer<typeof EmailOtpRequestSchema>;
export type EmailOtpVerifyBody = z.infer<typeof EmailOtpVerifySchema>;
export type PasswordForgotBody = z.infer<typeof PasswordForgotSchema>;
export type PasswordResetBody = z.infer<typeof PasswordResetSchema>;
export type GoogleSignInBody = z.infer<typeof GoogleSignInSchema>;
