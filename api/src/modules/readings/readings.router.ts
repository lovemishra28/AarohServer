import { Router } from 'express';
import { authenticate, requireAuth } from '../../common/auth-middleware';
import { asyncHandler, parseOrThrow } from '../../common/http';
import { SyncBatchSchema, screenSyncBatch } from '../segregation/segregation.dto';
import { emptySyncResult, syncProbeReadings } from '../segregation/segregation.service';
import { BatchReadingsSchema, CreateReadingSchema, type BatchReadingsBody } from './readings.dto';
import { createReadings } from './readings.service';

/**
 * Reading ingest (§6.2), mounted at /v1/readings.
 *
 * Two doors, on purpose. `POST /` is manual entry: the farmer already chose the
 * field, so the reading arrives knowing where it belongs. `POST /sync` is the
 * stick: readings arrive with GPS and no field, and the server works out the
 * fields by clustering (see `modules/segregation`).
 *
 * They stay separate rather than becoming one polymorphic endpoint because they
 * fail differently. Manual entry should reject a bad value loudly — the farmer is
 * looking at the screen and can fix it. A sync must not lose 89 good readings
 * because the probe lifted out of the soil on the 42nd, so it screens per reading
 * and reports what it dropped. Merging them would force one of those behaviours
 * onto the other.
 *
 * Both are idempotent per `idempotency_key`.
 */
export const readingsRouter = Router();
readingsRouter.use(authenticate);

// POST /v1/readings — ingest one reading or a batch.
readingsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body: unknown = req.body;
    let batch: BatchReadingsBody;

    if (body && typeof body === 'object' && 'readings' in body) {
      batch = parseOrThrow(BatchReadingsSchema, body);
    } else {
      batch = { readings: [parseOrThrow(CreateReadingSchema, body)] };
    }

    res.status(201).json(await createReadings(requireAuth(req), batch));
  }),
);

// POST /v1/readings/sync — ingest a stick walk and segregate it into fields.
readingsRouter.post(
  '/sync',
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(SyncBatchSchema, req.body);
    const { accepted, rejected, warnings } = screenSyncBatch(body);
    const { farmerId } = requireAuth(req);

    const result =
      accepted.length > 0
        ? await syncProbeReadings(farmerId, {
            readings: accepted,
            device: body.device
              ? {
                  serial: body.device.serial ?? null,
                  firmware_version: body.device.firmware_version ?? null,
                }
              : undefined,
          })
        : emptySyncResult(body.readings.length);

    // `received` counts everything sent, including readings screened out before
    // the service saw them — so received === stored + duplicates + rejected.
    res.status(201).json({ ...result, received: body.readings.length, rejected, warnings });
  }),
);
