import { Router } from 'express';
import { authenticate, requireAuth } from '../../common/auth-middleware';
import { AppError } from '../../common/errors';
import { asyncHandler, parseOrThrow } from '../../common/http';
import { UpdateMeSchema } from './farmers.dto';
import { findFarmerById, toPublicFarmer, updateFarmerProfile } from './farmers.repo';

/**
 * /v1/me (§6.2) — the authenticated farmer's own profile. Both routes sit behind
 * {@link authenticate}, so there is always a token to resolve, and both read the
 * farmer id from the token rather than the body: there is no way to address
 * someone else's profile through this router.
 */
export const meRouter = Router();

meRouter.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const { farmerId } = requireAuth(req);
    const farmer = await findFarmerById(farmerId);
    if (!farmer) throw new AppError('FARMER_NOT_FOUND', 'Account not found', 404);
    res.status(200).json({ farmer: toPublicFarmer(farmer) });
  }),
);

/**
 * PATCH /v1/me — partial profile update (name, language, region).
 *
 * Added in Phase 3 for the phone sign-up flow: `POST /v1/auth/otp/verify` has no
 * name field, so the client captures the name on the form and patches it in right
 * after the session exists.
 */
meRouter.patch(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const { farmerId } = requireAuth(req);
    const patch = parseOrThrow(UpdateMeSchema, req.body);
    const farmer = await updateFarmerProfile(farmerId, patch);
    if (!farmer) throw new AppError('FARMER_NOT_FOUND', 'Account not found', 404);
    res.status(200).json({ farmer: toPublicFarmer(farmer) });
  }),
);
