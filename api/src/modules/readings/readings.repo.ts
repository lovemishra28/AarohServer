import { getPool, type Queryable } from '../../common/db';
import type { CreateReadingBody } from './readings.dto';

/**
 * A `readings` row as read back. All nutrient/chemistry columns are `numeric`,
 * so pg returns them as strings; {@link toPublicReading} converts to numbers.
 * NPK columns are **elemental mg/kg** — the oxide basis appears only downstream
 * in a recommendation result, never here.
 */
export interface ReadingRow {
  id: string;
  device_id: string | null;
  field_id: string | null;
  taken_at: Date;
  location_geojson: string | null;
  n_mgkg: string | null;
  p_mgkg: string | null;
  k_mgkg: string | null;
  ph: string | null;
  ec_uscm: string | null;
  moisture_vwc: string | null;
  soil_temp_c: string | null;
  npk_is_calibrated: boolean;
  source: string;
  idempotency_key: string | null;
  raw_frame: string | null;
  created_at: Date;
}

export interface PublicReading {
  id: string;
  device_id: string | null;
  field_id: string | null;
  taken_at: string;
  location: unknown | null;
  n_mgkg: number | null;
  p_mgkg: number | null;
  k_mgkg: number | null;
  ph: number | null;
  ec_uscm: number | null;
  moisture_vwc: number | null;
  soil_temp_c: number | null;
  npk_is_calibrated: boolean;
  source: string;
  idempotency_key: string | null;
  created_at: string;
}

const SELECT_COLS = `
  id, device_id, field_id, taken_at,
  ST_AsGeoJSON(location) AS location_geojson,
  n_mgkg, p_mgkg, k_mgkg, ph, ec_uscm, moisture_vwc, soil_temp_c,
  npk_is_calibrated, source, idempotency_key, raw_frame, created_at
`;

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export function toPublicReading(row: ReadingRow): PublicReading {
  return {
    id: row.id,
    device_id: row.device_id,
    field_id: row.field_id,
    taken_at: row.taken_at.toISOString(),
    location: row.location_geojson ? JSON.parse(row.location_geojson) : null,
    n_mgkg: num(row.n_mgkg),
    p_mgkg: num(row.p_mgkg),
    k_mgkg: num(row.k_mgkg),
    ph: num(row.ph),
    ec_uscm: num(row.ec_uscm),
    moisture_vwc: num(row.moisture_vwc),
    soil_temp_c: num(row.soil_temp_c),
    npk_is_calibrated: row.npk_is_calibrated,
    source: row.source,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Insert one reading. When an `idempotency_key` is supplied, a repeat insert is
 * a no-op that returns the already-stored row (`created: false`) — this is what
 * makes batch ingest safe to retry after a flaky connection.
 */
export async function insertReading(
  input: CreateReadingBody,
  db: Queryable = getPool(),
): Promise<{ row: ReadingRow; created: boolean }> {
  const params = [
    input.device_id ?? null,
    input.field_id ?? null,
    input.taken_at ? new Date(input.taken_at) : null,
    input.n_mgkg ?? null,
    input.p_mgkg ?? null,
    input.k_mgkg ?? null,
    input.ph ?? null,
    input.ec_uscm ?? null,
    input.moisture_vwc ?? null,
    input.soil_temp_c ?? null,
    input.npk_is_calibrated,
    input.source,
    input.idempotency_key ?? null,
    input.raw_frame ?? null,
  ];
  const insertSql = `
    INSERT INTO readings (
      device_id, field_id, taken_at, n_mgkg, p_mgkg, k_mgkg, ph, ec_uscm,
      moisture_vwc, soil_temp_c, npk_is_calibrated, source, idempotency_key, raw_frame
    ) VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `;

  if (input.idempotency_key) {
    const inserted = await db.query<ReadingRow>(
      `${insertSql} ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${SELECT_COLS}`,
      params,
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    // Conflict: the key already exists — return the stored row unchanged.
    const existing = await db.query<ReadingRow>(
      `SELECT ${SELECT_COLS} FROM readings WHERE idempotency_key = $1`,
      [input.idempotency_key],
    );
    return { row: existing.rows[0], created: false };
  }

  const inserted = await db.query<ReadingRow>(`${insertSql} RETURNING ${SELECT_COLS}`, params);
  return { row: inserted.rows[0], created: true };
}

export async function findReadingById(
  id: string,
  db: Queryable = getPool(),
): Promise<ReadingRow | null> {
  const { rows } = await db.query<ReadingRow>(
    `SELECT ${SELECT_COLS} FROM readings WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function findLatestReadingForField(
  fieldId: string,
  db: Queryable = getPool(),
): Promise<ReadingRow | null> {
  const { rows } = await db.query<ReadingRow>(
    `SELECT ${SELECT_COLS} FROM readings WHERE field_id = $1 ORDER BY taken_at DESC LIMIT 1`,
    [fieldId],
  );
  return rows[0] ?? null;
}

export async function listReadingsForField(
  fieldId: string,
  limit = 100,
  db: Queryable = getPool(),
): Promise<ReadingRow[]> {
  const { rows } = await db.query<ReadingRow>(
    `SELECT ${SELECT_COLS} FROM readings WHERE field_id = $1 ORDER BY taken_at DESC LIMIT $2`,
    [fieldId, limit],
  );
  return rows;
}

/**
 * One probe reading on its way in from a stick sync. Distinct from
 * {@link CreateReadingBody} because the two arrive knowing different things: a
 * manual entry knows its field and has no GPS, while a probe reading has GPS and
 * learns its field from segregation. `field_id` is therefore already resolved
 * here — possibly to null, for a point that could not be placed.
 */
export interface ProbeReadingInsert {
  field_id: string | null;
  device_id: string | null;
  taken_at: Date;
  lat: number | null;
  lng: number | null;
  session_id: string | null;
  n_mgkg: number | null;
  p_mgkg: number | null;
  k_mgkg: number | null;
  ph: number | null;
  ec_uscm: number | null;
  moisture_vwc: number | null;
  soil_temp_c: number | null;
  idempotency_key: string | null;
  raw_frame: string | null;
}

const PROBE_INSERT_COLUMNS = `
  field_id, device_id, taken_at, location, session_id,
  n_mgkg, p_mgkg, k_mgkg, ph, ec_uscm, moisture_vwc, soil_temp_c,
  idempotency_key, raw_frame, source, npk_is_calibrated
`;

/** Params per row in {@link insertProbeReadings}, and rows per statement. */
const PROBE_PARAMS_PER_ROW = 15;
const PROBE_CHUNK_ROWS = 100;

/**
 * Insert probe readings in bulk.
 *
 * Multi-row `VALUES` rather than a loop of single inserts: a walk is 50–100
 * points, and one round trip per point turns a sync into a hundred sequential
 * network waits inside an open transaction. Chunked so the parameter count stays
 * far below Postgres' 65535 limit.
 *
 * `ON CONFLICT (idempotency_key) DO NOTHING` makes a retried sync harmless, and
 * the returned keys are how the caller tells stored from already-stored: a row
 * that comes back was inserted now, a row that does not was there already.
 * Readings with no key (there should be none from the app, but the column is
 * nullable) always insert.
 */
export async function insertProbeReadings(
  rows: readonly ProbeReadingInsert[],
  db: Queryable = getPool(),
): Promise<{ inserted: number; insertedKeys: Set<string> }> {
  let inserted = 0;
  const insertedKeys = new Set<string>();

  for (let start = 0; start < rows.length; start += PROBE_CHUNK_ROWS) {
    const chunk = rows.slice(start, start + PROBE_CHUNK_ROWS);
    const params: unknown[] = [];
    const tuples = chunk.map((r, i) => {
      const p = i * PROBE_PARAMS_PER_ROW;
      params.push(
        r.field_id,
        r.device_id,
        r.taken_at,
        r.lng,
        r.lat,
        r.session_id,
        r.n_mgkg,
        r.p_mgkg,
        r.k_mgkg,
        r.ph,
        r.ec_uscm,
        r.moisture_vwc,
        r.soil_temp_c,
        r.idempotency_key,
        r.raw_frame,
      );
      // ST_MakePoint is strict, so a missing lat or lng yields NULL geometry
      // rather than a point at (0,0) in the Gulf of Guinea.
      return `(
        $${p + 1}::uuid, $${p + 2}::uuid, $${p + 3}::timestamptz,
        ST_SetSRID(ST_MakePoint($${p + 4}::double precision, $${p + 5}::double precision), 4326),
        $${p + 6}::text,
        $${p + 7}::numeric, $${p + 8}::numeric, $${p + 9}::numeric, $${p + 10}::numeric,
        $${p + 11}::numeric, $${p + 12}::numeric, $${p + 13}::numeric,
        $${p + 14}::text, $${p + 15}::text, 'probe_ble', false
      )`;
    });

    const { rows: returned } = await db.query<{ idempotency_key: string | null }>(
      `INSERT INTO readings (${PROBE_INSERT_COLUMNS})
       VALUES ${tuples.join(', ')}
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      params,
    );
    inserted += returned.length;
    for (const r of returned) if (r.idempotency_key) insertedKeys.add(r.idempotency_key);
  }

  return { inserted, insertedKeys };
}

/**
 * Is every reading in this field calibrated?
 *
 * `bool_and` rather than "any": the flag tells the agronomy engine whether NPK
 * numbers are lab-grade or a probe proxy, and a mean that mixes the two is only as
 * trustworthy as its weakest input. An empty field answers false — unknown is not
 * calibrated.
 */
export async function isFieldNpkCalibrated(
  fieldId: string,
  db: Queryable = getPool(),
): Promise<boolean> {
  const { rows } = await db.query<{ calibrated: boolean }>(
    `SELECT COALESCE(bool_and(npk_is_calibrated), false) AS calibrated
       FROM readings WHERE field_id = $1`,
    [fieldId],
  );
  return rows[0]?.calibrated ?? false;
}

/**
 * Which of these idempotency keys are already stored. Used before clustering so a
 * re-sent batch does not re-cluster points that already have a field — the insert
 * would ignore them anyway, but they would still skew the clusters that decide
 * where *new* points land.
 */
export async function findStoredIdempotencyKeys(
  keys: readonly string[],
  db: Queryable = getPool(),
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const { rows } = await db.query<{ idempotency_key: string }>(
    'SELECT idempotency_key FROM readings WHERE idempotency_key = ANY($1::text[])',
    [keys],
  );
  return new Set(rows.map((r) => r.idempotency_key));
}

