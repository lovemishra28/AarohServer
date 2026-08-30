import { withTransaction } from '../../common/db';
import { logger } from '../../common/logger';
import { resolveSyncDevice } from '../devices/devices.repo';
import { toPublicField, type PublicField } from '../fields/fields.repo';
import {
  findStoredIdempotencyKeys,
  insertProbeReadings,
  type ProbeReadingInsert,
} from '../readings/readings.repo';
import { centroidOf, dbscan, diameterMeters, type GeoPoint } from './dbscan';
import {
  CLUSTER_EPS_M,
  CLUSTER_MIN_POINTS,
  FIELD_MATCH_RADIUS_M,
} from './segregation.config';
import {
  attachOrphanReadingsWithin,
  findFieldRow,
  findMatchingField,
  insertAutoField,
  multiPointWkt,
  pointWkt,
  recomputeAutoFieldGeometry,
  refreshFieldAggregates,
} from './segregation.repo';

/**
 * Field segregation: turning a walk into fields.
 *
 * The stick knows nothing about fields. It emits measurements with a GPS fix, and
 * this module answers the question the farmer never has to: which plot was that?
 *
 * The order of operations is the design, so it is worth stating plainly.
 *
 * 1. **Deduplicate**, in the batch and against the database. A retried sync must
 *    change nothing, and duplicates must be removed *before* clustering — the
 *    insert would ignore them anyway, but they would still pull cluster centroids
 *    around and could tip a borderline point into the wrong field.
 * 2. **Cluster** the located readings by distance (`dbscan.ts`).
 * 3. **Match or create** a field per cluster. Matching first is what makes the
 *    second walk of a plot join the first instead of creating a twin.
 * 4. **Place the leftovers.** A point that clustered with nothing still gets a
 *    field if it falls near one; a reading with no GPS inherits the field of its
 *    session. Neither ever creates a field — inventing one from a single point
 *    would litter the farmer's list with fields they never walked.
 * 5. **Insert**, then re-derive geometry and means from what is now stored.
 *
 * Everything happens in one transaction. A sync that created a field, failed
 * halfway and left readings pointing at a boundary drawn from half a walk is worse
 * than a sync that failed outright, because the farmer would see a field with a
 * plausible-looking wrong shape.
 */

/** One reading as it arrives from the app, already validated by the DTO layer. */
export interface SyncReading {
  /** Stable per-reading key — the app's stored scan id. Makes the sync retryable. */
  idempotency_key: string;
  taken_at: Date;
  /** The stick's `SID`: one walk. Free text, groups readings, never clusters them. */
  session_id: string | null;
  lat: number | null;
  lng: number | null;
  n_mgkg: number | null;
  p_mgkg: number | null;
  k_mgkg: number | null;
  ph: number | null;
  ec_uscm: number | null;
  moisture_vwc: number | null;
  soil_temp_c: number | null;
  raw_frame: string | null;
}

export interface SyncInput {
  readings: SyncReading[];
  device?: { serial?: string | null; firmware_version?: string | null };
}

export interface SyncFieldSummary {
  field: PublicField;
  /** True if this sync brought the field into existence. */
  created: boolean;
  readings_added: number;
  /** Metres from the stored field to the cluster that matched it; null if created. */
  match_distance_m: number | null;
  /** Previously unassigned readings the field's new boundary took in. */
  orphans_adopted: number;
}

/** What DBSCAN decided, echoed back so a bad clustering is diagnosable. */
export interface SyncClusterSummary {
  points: number;
  diameter_m: number;
  centroid: GeoPoint;
  field_id: string;
  field_created: boolean;
}

export interface SyncResult {
  received: number;
  stored: number;
  /** Already present, in this batch or from an earlier sync. Not an error. */
  duplicates: number;
  /** Stored with no field: GPS-less and sessionless, or an isolated point. */
  unassigned: number;
  fields_created: number;
  fields_matched: number;
  fields: SyncFieldSummary[];
  clusters: SyncClusterSummary[];
  sessions: { session_id: string; readings: number; field_ids: string[] }[];
  device_id: string | null;
  /** The serial is registered to a different farmer, so `device_id` was dropped. */
  device_owned_by_other: boolean;
}

interface FieldTally {
  created: boolean;
  added: number;
  matchDistanceM: number | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * The result of a sync that stored nothing — every reading was screened out, or
 * every one was a duplicate. Not an error, and not worth opening a transaction
 * for, but the response shape must be identical either way or the app needs two
 * code paths to read one endpoint.
 */
export function emptySyncResult(received: number, duplicates = 0): SyncResult {
  return {
    received,
    stored: 0,
    duplicates,
    unassigned: 0,
    fields_created: 0,
    fields_matched: 0,
    fields: [],
    clusters: [],
    sessions: [],
    device_id: null,
    device_owned_by_other: false,
  };
}

function tally(
  tallies: Map<string, FieldTally>,
  fieldId: string,
  added: number,
  created: boolean,
  matchDistanceM: number | null,
): void {
  const existing = tallies.get(fieldId);
  if (!existing) {
    tallies.set(fieldId, { created, added, matchDistanceM });
    return;
  }
  existing.added += added;
  existing.created = existing.created || created;
  // Keep the closest observed match — several clusters can land on one field.
  if (
    matchDistanceM !== null &&
    (existing.matchDistanceM === null || matchDistanceM < existing.matchDistanceM)
  ) {
    existing.matchDistanceM = matchDistanceM;
  }
}

/**
 * Ingest a batch of probe readings, segregating them into fields.
 *
 * `farmerId` scopes everything: clusters are only ever matched against this
 * farmer's fields, and a new field is created under this farmer. There is no code
 * path here that reads or writes another farmer's row.
 */
export async function syncProbeReadings(
  farmerId: string,
  input: SyncInput,
): Promise<SyncResult> {
  // ── de-duplicate within the batch ────────────────────────────────────────────
  const seen = new Set<string>();
  const batch: SyncReading[] = [];
  let duplicates = 0;
  for (const r of input.readings) {
    if (seen.has(r.idempotency_key)) {
      duplicates += 1;
      continue;
    }
    seen.add(r.idempotency_key);
    batch.push(r);
  }

  return withTransaction(async (db) => {
    // ── the device this walk came from ─────────────────────────────────────────
    let deviceId: string | null = null;
    let deviceOwnedByOther = false;
    const serial = input.device?.serial?.trim();
    if (serial) {
      const device = await resolveSyncDevice(
        serial,
        farmerId,
        input.device?.firmware_version ?? null,
        db,
      );
      if (device.owner_farmer_id === farmerId) {
        deviceId = device.id;
      } else {
        // Someone else's stick. The readings are still this farmer's — they were
        // taken on their land — but linking them to a device they do not own
        // would let the other farmer's fields adopt them later.
        deviceOwnedByOther = true;
      }
    }

    // ── drop what is already stored ────────────────────────────────────────────
    const stored = await findStoredIdempotencyKeys(
      batch.map((r) => r.idempotency_key),
      db,
    );
    const fresh = batch.filter((r) => !stored.has(r.idempotency_key));
    duplicates += batch.length - fresh.length;

    const clusterSummaries: SyncClusterSummary[] = [];
    const tallies = new Map<string, FieldTally>();
    const assignment = new Array<string | null>(fresh.length).fill(null);

    // ── cluster the located readings ───────────────────────────────────────────
    const locatedIndex: number[] = [];
    const points: GeoPoint[] = [];
    fresh.forEach((r, i) => {
      if (r.lat === null || r.lng === null) return;
      locatedIndex.push(i);
      points.push({ lat: r.lat, lng: r.lng });
    });

    const { clusters, noise } =
      points.length > 0
        ? dbscan(points, { epsMeters: CLUSTER_EPS_M, minPoints: CLUSTER_MIN_POINTS })
        : { clusters: [], noise: [] };

    for (const members of clusters) {
      const memberPoints = members.map((m) => points[m]);
      const clusterWkt = multiPointWkt(memberPoints);

      const match = await findMatchingField(farmerId, clusterWkt, FIELD_MATCH_RADIUS_M, db);
      let fieldId: string;
      let created = false;
      let matchDistanceM: number | null = null;
      if (match) {
        fieldId = match.id;
        matchDistanceM = round1(match.distance_m);
      } else {
        const field = await insertAutoField(farmerId, clusterWkt, db);
        fieldId = field.id;
        created = true;
      }

      for (const m of members) assignment[locatedIndex[m]] = fieldId;
      tally(tallies, fieldId, members.length, created, matchDistanceM);

      const centre = centroidOf(memberPoints);
      clusterSummaries.push({
        points: members.length,
        diameter_m: round1(diameterMeters(memberPoints)),
        centroid: { lat: round6(centre.lat), lng: round6(centre.lng) },
        field_id: fieldId,
        field_created: created,
      });
    }

    // ── isolated points: join a field if there is one, never make one ──────────
    // Fields created above are already visible to this query — same transaction —
    // so a stray point beside a cluster still lands in the right field.
    for (const n of noise) {
      const match = await findMatchingField(
        farmerId,
        pointWkt(points[n]),
        FIELD_MATCH_RADIUS_M,
        db,
      );
      if (!match) continue;
      assignment[locatedIndex[n]] = match.id;
      tally(tallies, match.id, 1, false, round1(match.distance_m));
    }

    // ── readings with no GPS inherit their session's field ─────────────────────
    // The stick reports `GPS:PENDING` until it gets a fix, so the first readings
    // of a walk routinely have no position while the rest do. They were taken in
    // the same plot minutes apart; the session is the only honest link.
    const sessionVotes = new Map<string, Map<string, number>>();
    fresh.forEach((r, i) => {
      const fieldId = assignment[i];
      if (!r.session_id || !fieldId) return;
      const votes = sessionVotes.get(r.session_id) ?? new Map<string, number>();
      votes.set(fieldId, (votes.get(fieldId) ?? 0) + 1);
      sessionVotes.set(r.session_id, votes);
    });

    const sessionField = new Map<string, string>();
    for (const [sessionId, votes] of sessionVotes) {
      let best: string | null = null;
      let bestCount = 0;
      for (const [fieldId, count] of votes) {
        if (count > bestCount) {
          best = fieldId;
          bestCount = count;
        }
      }
      if (best) sessionField.set(sessionId, best);
    }

    fresh.forEach((r, i) => {
      if (assignment[i] !== null || !r.session_id) return;
      const fieldId = sessionField.get(r.session_id);
      if (!fieldId) return;
      assignment[i] = fieldId;
      tally(tallies, fieldId, 1, false, null);
    });

    // ── store ─────────────────────────────────────────────────────────────────
    const rows: ProbeReadingInsert[] = fresh.map((r, i) => ({
      field_id: assignment[i],
      device_id: deviceId,
      taken_at: r.taken_at,
      lat: r.lat,
      lng: r.lng,
      session_id: r.session_id,
      n_mgkg: r.n_mgkg,
      p_mgkg: r.p_mgkg,
      k_mgkg: r.k_mgkg,
      ph: r.ph,
      ec_uscm: r.ec_uscm,
      moisture_vwc: r.moisture_vwc,
      soil_temp_c: r.soil_temp_c,
      idempotency_key: r.idempotency_key,
      raw_frame: r.raw_frame,
    }));
    const inserted = rows.length > 0 ? (await insertProbeReadings(rows, db)).inserted : 0;

    // ── re-derive geometry and means from what is now stored ───────────────────
    const fields: SyncFieldSummary[] = [];
    let fieldsCreated = 0;
    let fieldsMatched = 0;

    for (const [fieldId, t] of tallies) {
      // Geometry first: the boundary has to include this walk before it can be
      // asked which older strays fall inside it.
      await recomputeAutoFieldGeometry(fieldId, db);
      const orphans = await attachOrphanReadingsWithin(fieldId, farmerId, db);
      if (orphans > 0) await recomputeAutoFieldGeometry(fieldId, db);
      await refreshFieldAggregates(fieldId, db);

      const row = await findFieldRow(fieldId, db);
      if (!row) continue;
      if (t.created) fieldsCreated += 1;
      else fieldsMatched += 1;

      fields.push({
        field: toPublicField(row),
        created: t.created,
        readings_added: t.added,
        match_distance_m: t.matchDistanceM,
        orphans_adopted: orphans,
      });
    }

    // Newest first, so the field the farmer just walked heads the list.
    fields.sort((a, b) => (a.created === b.created ? 0 : a.created ? -1 : 1));

    // ── per-session report, for the app's scan log ─────────────────────────────
    const sessionRollup = new Map<string, { readings: number; fieldIds: Set<string> }>();
    fresh.forEach((r, i) => {
      if (!r.session_id) return;
      const entry = sessionRollup.get(r.session_id) ?? { readings: 0, fieldIds: new Set<string>() };
      entry.readings += 1;
      const fieldId = assignment[i];
      if (fieldId) entry.fieldIds.add(fieldId);
      sessionRollup.set(r.session_id, entry);
    });

    const result: SyncResult = {
      received: input.readings.length,
      stored: inserted,
      duplicates,
      unassigned: assignment.filter((f) => f === null).length,
      fields_created: fieldsCreated,
      fields_matched: fieldsMatched,
      fields,
      clusters: clusterSummaries,
      sessions: [...sessionRollup].map(([session_id, e]) => ({
        session_id,
        readings: e.readings,
        field_ids: [...e.fieldIds],
      })),
      device_id: deviceId,
      device_owned_by_other: deviceOwnedByOther,
    };

    logger.info('readings_sync_segregated', {
      farmer_id: farmerId,
      received: result.received,
      stored: result.stored,
      duplicates: result.duplicates,
      unassigned: result.unassigned,
      clusters: clusterSummaries.length,
      noise: noise.length,
      fields_created: fieldsCreated,
      fields_matched: fieldsMatched,
    });

    return result;
  });
}
