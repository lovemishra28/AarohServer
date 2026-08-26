import { Router } from 'express';
import { authenticate, requireAuth } from '../../common/auth-middleware';
import { AppError } from '../../common/errors';
import { asyncHandler } from '../../common/http';
import { findFarmerById, toPublicFarmer } from './farmers.repo';

/**
 * GET /v1/me (§6.2) — the authenticated farmer's own profile. Mounted at
 * /v1/me. Behind {@link authenticate}, so it always has a token to resolve.
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
