import { Router } from 'express';
import { asyncHandler, parseOrThrow } from '../../common/http';
import {
  EmailLoginSchema,
  EmailOtpRequestSchema,
  EmailOtpVerifySchema,
  EmailRegisterSchema,
  GoogleSignInSchema,
  LogoutSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  PasswordForgotSchema,
  PasswordResetSchema,
  RefreshSchema,
} from './auth.dto';
import {
  forgotPassword,
  loginWithEmail,
  registerWithEmail,
  requestEmailOtp,
  resetPassword,
  verifyEmailOtp,
} from './auth.email.service';
import { signInWithGoogle } from './auth.google.service';
import { logout, refresh, requestOtp, verifyOtp } from './auth.service';

/**
 * Auth routes (§6.2), mounted at /v1/auth. HTTP only — all logic lives in the
 * service files. Three doors into the same session:
 *
 *   phone   : POST otp/request  → otp/verify
 *   email   : POST email/register | email/login
 *             POST email/otp/request → email/otp/verify   (passwordless)
 *             POST password/forgot   → password/reset
 *   google  : POST google
 *
 * Every one of them answers with the **same** envelope — `{ farmer, ...tokens }` —
 * because the client stores a session identically no matter how it was obtained
 * (`AAROH-Client/src/store/authStore.ts`). Keeping that shape uniform is what lets
 * a new provider be added without touching the client's session handling.
 */
export const authRouter = Router();

/* ─── Phone + OTP ───────────────────────────────────────────────────────────── */

// POST /v1/auth/otp/request — issue a login code (dev stub: no SMS).
authRouter.post(
  '/otp/request',
  asyncHandler(async (req, res) => {
    const { phone } = parseOrThrow(OtpRequestSchema, req.body);
    res.status(200).json(await requestOtp(phone));
  }),
);

// POST /v1/auth/otp/verify — exchange a valid code for tokens (creates the
// farmer on first login).
authRouter.post(
  '/otp/verify',
  asyncHandler(async (req, res) => {
    const { phone, code } = parseOrThrow(OtpVerifySchema, req.body);
    const { farmer, tokens } = await verifyOtp(phone, code);
    res.status(200).json({ farmer, ...tokens });
  }),
);

/* ─── Email + password ──────────────────────────────────────────────────────── */

// POST /v1/auth/email/register — create an account and sign in. 201, because a
// farmer row is created; a verification code is emailed alongside.
authRouter.post(
  '/email/register',
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(EmailRegisterSchema, req.body);
    const { farmer, tokens, verification } = await registerWithEmail(body);
    res.status(201).json({ farmer, ...tokens, verification });
  }),
);

// POST /v1/auth/email/login — email + password sign-in.
authRouter.post(
  '/email/login',
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(EmailLoginSchema, req.body);
    const { farmer, tokens } = await loginWithEmail(body);
    res.status(200).json({ farmer, ...tokens });
  }),
);

/* ─── Email one-time codes ─────────────────────────────────────────────────── */

// POST /v1/auth/email/otp/request — email a login or verification code.
authRouter.post(
  '/email/otp/request',
  asyncHandler(async (req, res) => {
    const { email, purpose } = parseOrThrow(EmailOtpRequestSchema, req.body);
    res.status(200).json(await requestEmailOtp(email, purpose));
  }),
);

// POST /v1/auth/email/otp/verify — redeem an email code for tokens.
authRouter.post(
  '/email/otp/verify',
  asyncHandler(async (req, res) => {
    const { email, code, purpose } = parseOrThrow(EmailOtpVerifySchema, req.body);
    const { farmer, tokens } = await verifyEmailOtp(email, code, purpose);
    res.status(200).json({ farmer, ...tokens });
  }),
);

/* ─── Password reset ───────────────────────────────────────────────────────── */

// POST /v1/auth/password/forgot — email a reset code. Always 200 (never reveals
// whether the address is registered).
authRouter.post(
  '/password/forgot',
  asyncHandler(async (req, res) => {
    const { email } = parseOrThrow(PasswordForgotSchema, req.body);
    res.status(200).json(await forgotPassword(email));
  }),
);

// POST /v1/auth/password/reset — set a new password with a reset code, revoking
// every existing session.
authRouter.post(
  '/password/reset',
  asyncHandler(async (req, res) => {
    const { email, code, password } = parseOrThrow(PasswordResetSchema, req.body);
    const { farmer, tokens } = await resetPassword(email, code, password);
    res.status(200).json({ farmer, ...tokens });
  }),
);

/* ─── Google ────────────────────────────────────────────────────────────────── */

// POST /v1/auth/google — exchange a verified Google ID token for a session.
authRouter.post(
  '/google',
  asyncHandler(async (req, res) => {
    const { id_token } = parseOrThrow(GoogleSignInSchema, req.body);
    const { farmer, tokens } = await signInWithGoogle(id_token);
    res.status(200).json({ farmer, ...tokens });
  }),
);

/* ─── Session ───────────────────────────────────────────────────────────────── */

// POST /v1/auth/refresh — rotate a refresh token for a new bundle.
authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refresh_token } = parseOrThrow(RefreshSchema, req.body);
    res.status(200).json(await refresh(refresh_token));
  }),
);

// POST /v1/auth/logout — revoke the refresh token (or every session with
// `all: true`). Unauthenticated on purpose: the refresh token *is* the credential,
// and sign-out must still work when the access token has already expired. Always
// 200 so the client can clear local state unconditionally.
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const { refresh_token, all } = parseOrThrow(LogoutSchema, req.body);
    res.status(200).json(await logout(refresh_token, all));
  }),
);
