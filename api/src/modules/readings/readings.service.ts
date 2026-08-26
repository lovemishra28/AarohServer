import { type AuthContext } from '../../common/auth-middleware';
import { withClient } from '../../common/db';
import { getOwnedFieldOrThrow } from '../fields/fields.service';
import type { CreateReadingBody } from './readings.dto';
import { type PublicReading, insertReading, listReadingsForField, toPublicReading } from './readings.repo';

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
  readings: CreateReadingBody[],
): Promise<IngestResult> {
  const fieldIds = new Set(readings.map((r) => r.field_id).filter((id): id is string => !!id));
  for (const fieldId of fieldIds) {
    await getOwnedFieldOrThrow(auth, fieldId);
  }

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const out: PublicReading[] = [];
      let created = 0;
      for (const r of readings) {
        const { row, created: wasCreated } = await insertReading(r, client);
        out.push(toPublicReading(row));
        if (wasCreated) created += 1;
      }
      await client.query('COMMIT');
      return {
        readings: out,
        created_count: created,
        duplicate_count: readings.length - created,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
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
