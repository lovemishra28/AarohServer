import { Router } from 'express';
import { authenticate, requireAuth } from '../../common/auth-middleware';
import { asyncHandler, parseOrThrow } from '../../common/http';
import { BatchReadingsSchema, CreateReadingSchema } from './readings.dto';
import { createReadings } from './readings.service';

/**
 * Reading ingest (§6.2), mounted at /v1/readings. Accepts either a single
 * reading object or a `{ readings: [...] }` batch — the app queues readings
 * offline and flushes them in bulk, so both shapes are convenient. Ingest is
 * idempotent per `idempotency_key`.
 */
export const readingsRouter = Router();
readingsRouter.use(authenticate);

// POST /v1/readings — ingest one reading or a batch.
readingsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body: unknown = req.body;
    const readings =
      body && typeof body === 'object' && 'readings' in body
        ? parseOrThrow(BatchReadingsSchema, body).readings
        : [parseOrThrow(CreateReadingSchema, body)];

    res.status(201).json(await createReadings(requireAuth(req), readings));
  }),
);
