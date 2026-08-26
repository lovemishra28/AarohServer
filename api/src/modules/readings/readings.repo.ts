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
