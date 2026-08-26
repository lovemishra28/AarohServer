import { Router } from 'express';
import { asyncHandler, parseOrThrow } from '../../common/http';
import { OtpRequestSchema, OtpVerifySchema, RefreshSchema } from './auth.dto';
import { refresh, requestOtp, verifyOtp } from './auth.service';

/**
 * Auth routes (§6.2), mounted at /v1/auth. HTTP only — all logic is in
 * auth.service. The farmer login flow is: request a one-time code, verify it for
 * tokens, then refresh the access token as needed.
 */
export const authRouter = Router();

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

// POST /v1/auth/refresh — rotate a refresh token for a new bundle.
authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refresh_token } = parseOrThrow(RefreshSchema, req.body);
    res.status(200).json(await refresh(refresh_token));
  }),
);
