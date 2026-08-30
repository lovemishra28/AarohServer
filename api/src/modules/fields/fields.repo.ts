import { getPool, type Queryable } from '../../common/db';
import type { CreateFieldBody } from './fields.dto';

/**
 * A `fields` row as read back, with its aggregate means joined on. `area_ha` and
 * every `numeric` arrive as strings (pg returns `numeric` as text to preserve
 * precision); geometry is read as GeoJSON text via ST_AsGeoJSON.
 * {@link toPublicField} normalises both.
 *
 * The aggregate columns are prefixed `agg_` and are all null for a field that has
 * no readings yet — a manually created field before its first walk, most often.
 */
export interface FieldRow {
  id: string;
  farmer_id: string;
  name: string | null;
  area_ha: string | null;
  region_code: string;
  created_at: Date;
  source: string;
  detected_at: Date | null;
  centroid_geojson: string | null;
  boundary_geojson: string | null;
  agg_reading_count: number | null;
  agg_n_mgkg: string | null;
  agg_p_mgkg: string | null;
  agg_k_mgkg: string | null;
  agg_ph: string | null;
  agg_ec_uscm: string | null;
  agg_moisture_vwc: string | null;
  agg_soil_temp_c: string | null;
  agg_first_reading_at: Date | null;
  agg_last_reading_at: Date | null;
  agg_updated_at: Date | null;
}

/**
 * The field's aggregate latest reading: the mean of every reading assigned to it.
 * NPK are elemental mg/kg, the same basis as `readings` — never oxide.
 */
export interface PublicFieldAggregate {
  reading_count: number;
  n_mgkg: number | null;
  p_mgkg: number | null;
  k_mgkg: number | null;
  ph: number | null;
  ec_uscm: number | null;
  moisture_vwc: number | null;
  soil_temp_c: number | null;
  first_reading_at: string | null;
  last_reading_at: string | null;
  updated_at: string | null;
}

export interface PublicField {
  id: string;
  farmer_id: string;
  name: string | null;
  area_ha: number | null;
  region_code: string;
  created_at: string;
  /** `'auto'` if segregation inferred this field from a GPS cluster. */
  source: string;
  detected_at: string | null;
  centroid: unknown | null;
  boundary: unknown | null;
  /** Null until the field has at least one reading. */
  aggregate: PublicFieldAggregate | null;
}

// One column list and one FROM clause so every read returns the same shape —
// including the aggregate join, which the dashboard needs on the list endpoint
// (a field switcher shows each field's numbers without a request per field).
// Geometry is emitted as GeoJSON so callers never see raw WKB.
const FIELD_COLS = `
  f.id, f.farmer_id, f.name, f.area_ha, f.region_code, f.created_at,
  f.source, f.detected_at,
  ST_AsGeoJSON(f.centroid) AS centroid_geojson,
  ST_AsGeoJSON(f.boundary) AS boundary_geojson
`;

const AGGREGATE_COLS = `
  a.reading_count AS agg_reading_count,
  a.n_mgkg AS agg_n_mgkg,
  a.p_mgkg AS agg_p_mgkg,
  a.k_mgkg AS agg_k_mgkg,
  a.ph AS agg_ph,
  a.ec_uscm AS agg_ec_uscm,
  a.moisture_vwc AS agg_moisture_vwc,
  a.soil_temp_c AS agg_soil_temp_c,
  a.first_reading_at AS agg_first_reading_at,
  a.last_reading_at AS agg_last_reading_at,
  a.updated_at AS agg_updated_at
`;

export const FIELD_SELECT_COLS = `${FIELD_COLS}, ${AGGREGATE_COLS}`;
export const FIELD_SELECT_FROM = 'fields f LEFT JOIN field_aggregates a ON a.field_id = f.id';

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const iso = (v: Date | null): string | null => (v === null ? null : v.toISOString());

function toAggregate(row: FieldRow): PublicFieldAggregate | null {
  if (row.agg_reading_count === null) return null;
  return {
    reading_count: row.agg_reading_count,
    n_mgkg: num(row.agg_n_mgkg),
    p_mgkg: num(row.agg_p_mgkg),
    k_mgkg: num(row.agg_k_mgkg),
    ph: num(row.agg_ph),
    ec_uscm: num(row.agg_ec_uscm),
    moisture_vwc: num(row.agg_moisture_vwc),
    soil_temp_c: num(row.agg_soil_temp_c),
    first_reading_at: iso(row.agg_first_reading_at),
    last_reading_at: iso(row.agg_last_reading_at),
    updated_at: iso(row.agg_updated_at),
  };
}

export function toPublicField(row: FieldRow): PublicField {
  return {
    id: row.id,
    farmer_id: row.farmer_id,
    name: row.name,
    area_ha: num(row.area_ha),
    region_code: row.region_code,
    created_at: row.created_at.toISOString(),
    source: row.source,
    detected_at: iso(row.detected_at),
    centroid: row.centroid_geojson ? JSON.parse(row.centroid_geojson) : null,
    boundary: row.boundary_geojson ? JSON.parse(row.boundary_geojson) : null,
    aggregate: toAggregate(row),
  };
}

/**
 * Insert then re-read, rather than `RETURNING` the column list: the aggregate join
 * cannot appear in a RETURNING clause, and one read path is worth one extra query
 * on a rare write.
 */
export async function createField(
  farmerId: string,
  input: CreateFieldBody,
  db: Queryable = getPool(),
): Promise<FieldRow> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO fields (farmer_id, name, area_ha, region_code, source)
     VALUES ($1, $2, $3, $4, 'manual')
     RETURNING id`,
    [farmerId, input.name ?? null, input.area_ha ?? null, input.region_code],
  );
  const row = await findFieldById(rows[0].id, db);
  if (!row) throw new Error('createField: inserted field could not be read back');
  return row;
}

export async function listFieldsByFarmer(
  farmerId: string,
  db: Queryable = getPool(),
): Promise<FieldRow[]> {
  const { rows } = await db.query<FieldRow>(
    `SELECT ${FIELD_SELECT_COLS} FROM ${FIELD_SELECT_FROM}
     WHERE f.farmer_id = $1
     ORDER BY f.created_at DESC`,
    [farmerId],
  );
  return rows;
}

export async function findFieldById(
  id: string,
  db: Queryable = getPool(),
): Promise<FieldRow | null> {
  const { rows } = await db.query<FieldRow>(
    `SELECT ${FIELD_SELECT_COLS} FROM ${FIELD_SELECT_FROM} WHERE f.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
