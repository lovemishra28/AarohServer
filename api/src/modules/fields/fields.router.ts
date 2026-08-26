import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../../common/auth-middleware';
import { asyncHandler, parseOrThrow } from '../../common/http';
import { listReadings } from '../readings/readings.service';
import { CreateRecommendationSchema } from '../recommendations/recommendations.dto';
import {
  createRecommendation,
  listRecommendations,
} from '../recommendations/recommendations.service';
import { CreateFieldSchema } from './fields.dto';
import { createField, getFieldDetail, listFields } from './fields.service';

/**
 * Field routes (§6.2), mounted at /v1/fields. Every route is authenticated and
 * ownership-checked in the service layer. Sub-resources that hang off a field
 * (its readings; its recommendations, added with the money path) live here so
 * all /v1/fields/* paths are owned by one router.
 */
export const fieldsRouter = Router();
fieldsRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });

// GET /v1/fields — the caller's fields.
fieldsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.status(200).json({ fields: await listFields(requireAuth(req)) });
  }),
);

// POST /v1/fields — create a field for the caller.
fieldsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(CreateFieldSchema, req.body);
    res.status(201).json({ field: await createField(requireAuth(req), input) });
  }),
);

// GET /v1/fields/:id — a field plus its latest reading.
fieldsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    res.status(200).json(await getFieldDetail(requireAuth(req), id));
  }),
);

// GET /v1/fields/:id/readings — the field's readings, newest first.
fieldsRouter.get(
  '/:id/readings',
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    res.status(200).json({ readings: await listReadings(requireAuth(req), id) });
  }),
);

// POST /v1/fields/:id/recommendations — the money path (§10). Runs the AI +
// agronomy pipeline against the field's latest (or a pinned) reading.
fieldsRouter.post(
  '/:id/recommendations',
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    const body = parseOrThrow(CreateRecommendationSchema, req.body ?? {});
    const recommendation = await createRecommendation(requireAuth(req), id, body);
    res.status(201).json({ recommendation });
  }),
);

// GET /v1/fields/:id/recommendations — the field's saved recommendations.
fieldsRouter.get(
  '/:id/recommendations',
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    res.status(200).json({ recommendations: await listRecommendations(requireAuth(req), id) });
  }),
);
