import { type AuthContext } from '../../common/auth-middleware';
import { withTransaction } from '../../common/db';
import { logger } from '../../common/logger';
import { resolveSyncDevice } from '../devices/devices.repo';
import { getOwnedFieldOrThrow } from '../fields/fields.service';
import type { BatchReadingsBody } from './readings.dto';
import {
  type PublicReading,
  type HistoryReading,
  insertReading,
  listReadingsForField,
  listReadingsForFarmer,
  toPublicReading,
  toHistoryReading,
} from './readings.repo';

export interface IngestResult {
  readings: PublicReading[];
  created_count: number;
  duplicate_count: number;
}

/**
 * Ingest a batch of readings atomically (§6.1). Every distinct `field_id` is
 * ownership-checked up front, then all rows are inserted in one transaction so a
 * partial batch never lands. Readings carrying an already-seen `idempotency_key`
 * are returned unchanged and counted as duplicates rather than re-inserted.
 */
export async function createReadings(
  auth: AuthContext,
  batch: BatchReadingsBody,
): Promise<IngestResult> {
  const { readings, device_metadata } = batch;

  const fieldIds = new Set(readings.map((r) => r.field_id).filter((id): id is string => !!id));
  for (const fieldId of fieldIds) {
    await getOwnedFieldOrThrow(auth, fieldId);
  }

  return withTransaction(async (client) => {
    // `probe_id` is a *serial* — the string on the stick's label — while
    // `readings.device_id` is a uuid foreign key. Assigning one to the other used
    // to happen here and made Postgres reject the whole batch with an invalid-uuid
    // error, since a serial is not a uuid. Resolve it to a real device row instead,
    // registering the stick on first sight, and only link readings to it when this
    // farmer actually owns it.
    let resolvedDeviceId: string | null = null;
    if (device_metadata?.probe_id) {
      const device = await resolveSyncDevice(
        device_metadata.probe_id,
        auth.farmerId,
        device_metadata.firmware_version ?? null,
        client,
      );
      if (device.owner_farmer_id === auth.farmerId) resolvedDeviceId = device.id;
      else logger.warn('reading_device_owned_by_other', { serial: device_metadata.probe_id });
    }

    const out: PublicReading[] = [];
    let created = 0;
    for (const r of readings) {
      const { row, created: wasCreated } = await insertReading(
        r.device_id ? r : { ...r, device_id: resolvedDeviceId ?? undefined },
        client,
      );
      out.push(toPublicReading(row));
      if (wasCreated) created += 1;
    }

    return {
      readings: out,
      created_count: created,
      duplicate_count: readings.length - created,
    };
  });
}

/** GET /v1/fields/:id/readings — the field's readings, newest first (§6.2). */
export async function listReadings(
  auth: AuthContext,
  fieldId: string,
  limit = 100,
): Promise<PublicReading[]> {
  await getOwnedFieldOrThrow(auth, fieldId);
  const rows = await listReadingsForField(fieldId, limit);
  return rows.map(toPublicReading);
}

/** GET /v1/readings/history — all readings for the authenticated farmer. */
export async function listReadingsHistory(
  auth: AuthContext,
  limit = 200,
): Promise<HistoryReading[]> {
  const rows = await listReadingsForFarmer(auth.farmerId, limit);
  return rows.map(toHistoryReading);
}
