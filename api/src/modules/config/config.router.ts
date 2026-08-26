import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/auth-middleware';
import { asyncHandler, parseOrThrow } from '../../common/http';
import { getActiveRegionConfig } from './config.repo';

/**
 * Config routes (§6.2), mounted at /v1/config. Authenticated, read-only exposure
 * of the seeded agronomy reference data (prices, RDF bands, class thresholds) so
 * the app never hard-codes numbers that live in the region tables.
 */
export const configRouter = Router();
configRouter.use(authenticate);

const CodeParam = z.object({ code: z.string().min(1).max(40) });

// GET /v1/config/region/:code — the active configuration for a region.
configRouter.get(
  '/region/:code',
  asyncHandler(async (req, res) => {
    const { code } = parseOrThrow(CodeParam, req.params);
    res.status(200).json({ config: await getActiveRegionConfig(code) });
  }),
);
