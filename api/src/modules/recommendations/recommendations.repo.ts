import { getPool, type Queryable } from '../../common/db';
import type { RecommendationResult } from '../../common/ai-client';

/**
 * A `recommendations` row. The full §6.4 payload returned to the app lives in
 * the `result` jsonb column exactly as the Python service produced it, so a
 * stored recommendation always renders identically to when it was created — the
 * versions that produced it (`model_version`, `agronomy_version`) are pinned
 * alongside for auditability.
 */
export interface RecommendationRow {
  id: string;
  field_id: string;
  reading_id: string | null;
  model_version: string;
  agronomy_version: string;
  region_code: string;
  area_ha: string;
  result: RecommendationResult;
  created_at: Date;
}

export interface PublicRecommendation {
  id: string;
  field_id: string;
  reading_id: string | null;
  model_version: string;
  agronomy_version: string;
  region_code: string;
  area_ha: number;
  result: RecommendationResult;
  created_at: string;
}

export function toPublicRecommendation(row: RecommendationRow): PublicRecommendation {
  return {
    id: row.id,
    field_id: row.field_id,
    reading_id: row.reading_id,
    model_version: row.model_version,
    agronomy_version: row.agronomy_version,
    region_code: row.region_code,
    area_ha: Number(row.area_ha),
    result: row.result,
    created_at: row.created_at.toISOString(),
  };
}

export interface InsertRecommendationInput {
  field_id: string;
  reading_id: string | null;
  model_version: string;
  agronomy_version: string;
  region_code: string;
  area_ha: number;
  result: RecommendationResult;
}

export async function insertRecommendation(
  input: InsertRecommendationInput,
  db: Queryable = getPool(),
): Promise<RecommendationRow> {
  const { rows } = await db.query<RecommendationRow>(
    `INSERT INTO recommendations (
       field_id, reading_id, model_version, agronomy_version, region_code, area_ha, result
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.field_id,
      input.reading_id,
      input.model_version,
      input.agronomy_version,
      input.region_code,
      input.area_ha,
      input.result,
    ],
  );
  return rows[0];
}

export async function listRecommendationsForField(
  fieldId: string,
  limit = 50,
  db: Queryable = getPool(),
): Promise<RecommendationRow[]> {
  const { rows } = await db.query<RecommendationRow>(
    `SELECT * FROM recommendations WHERE field_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [fieldId, limit],
  );
  return rows;
}
