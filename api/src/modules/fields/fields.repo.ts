import { getPool, type Queryable } from '../../common/db';
import type { CreateFieldBody } from './fields.dto';

/**
 * A `fields` row as read back. `area_ha` arrives as a string (pg returns
 * `numeric` as text to preserve precision); geometry is read as GeoJSON text via
 * ST_AsGeoJSON. {@link toPublicField} normalises both.
 */
export interface FieldRow {
  id: string;
  farmer_id: string;
  name: string | null;
  area_ha: string | null;
  region_code: string;
  created_at: Date;
  centroid_geojson: string | null;
  boundary_geojson: string | null;
}

export interface PublicField {
  id: string;
  farmer_id: string;
  name: string | null;
  area_ha: number | null;
  region_code: string;
  created_at: string;
  centroid: unknown | null;
  boundary: unknown | null;
}

// One column list so every read returns the same shape. Geometry is emitted as
// GeoJSON so callers never see raw WKB.
const SELECT_COLS = `
  id, farmer_id, name, area_ha, region_code, created_at,
  ST_AsGeoJSON(centroid) AS centroid_geojson,
  ST_AsGeoJSON(boundary) AS boundary_geojson
`;

export function toPublicField(row: FieldRow): PublicField {
  return {
    id: row.id,
    farmer_id: row.farmer_id,
    name: row.name,
    area_ha: row.area_ha === null ? null : Number(row.area_ha),
    region_code: row.region_code,
    created_at: row.created_at.toISOString(),
    centroid: row.centroid_geojson ? JSON.parse(row.centroid_geojson) : null,
    boundary: row.boundary_geojson ? JSON.parse(row.boundary_geojson) : null,
  };
}

export async function createField(
  farmerId: string,
  input: CreateFieldBody,
  db: Queryable = getPool(),
): Promise<FieldRow> {
  const { rows } = await db.query<FieldRow>(
    `INSERT INTO fields (farmer_id, name, area_ha, region_code)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLS}`,
    [farmerId, input.name ?? null, input.area_ha ?? null, input.region_code],
  );
  return rows[0];
}

export async function listFieldsByFarmer(
  farmerId: string,
  db: Queryable = getPool(),
): Promise<FieldRow[]> {
  const { rows } = await db.query<FieldRow>(
    `SELECT ${SELECT_COLS} FROM fields WHERE farmer_id = $1 ORDER BY created_at DESC`,
    [farmerId],
  );
  return rows;
}

export async function findFieldById(
  id: string,
  db: Queryable = getPool(),
): Promise<FieldRow | null> {
  const { rows } = await db.query<FieldRow>(
    `SELECT ${SELECT_COLS} FROM fields WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
