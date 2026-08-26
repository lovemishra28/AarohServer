import { getPool, type Queryable } from '../../common/db';
import type { CreateFeedbackBody } from './feedback.dto';

export interface FeedbackRow {
  id: string;
  recommendation_id: string;
  farmer_id: string;
  chosen_crop: string | null;
  actually_planted: string | null;
  outcome: string | null;
  lab_test: unknown | null;
  created_at: Date;
}

export interface PublicFeedback {
  id: string;
  recommendation_id: string;
  farmer_id: string;
  chosen_crop: string | null;
  actually_planted: string | null;
  outcome: string | null;
  lab_test: unknown | null;
  created_at: string;
}

export function toPublicFeedback(row: FeedbackRow): PublicFeedback {
  return {
    id: row.id,
    recommendation_id: row.recommendation_id,
    farmer_id: row.farmer_id,
    chosen_crop: row.chosen_crop,
    actually_planted: row.actually_planted,
    outcome: row.outcome,
    lab_test: row.lab_test,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Return the owning farmer of the field a recommendation belongs to, or null if
 * the recommendation does not exist. Used to authorise feedback: you may only
 * give feedback on a recommendation for your own field.
 */
export async function findRecommendationOwner(
  recommendationId: string,
  db: Queryable = getPool(),
): Promise<string | null> {
  const { rows } = await db.query<{ farmer_id: string }>(
    `SELECT f.farmer_id
       FROM recommendations r
       JOIN fields f ON f.id = r.field_id
      WHERE r.id = $1`,
    [recommendationId],
  );
  return rows[0]?.farmer_id ?? null;
}

export async function insertFeedback(
  farmerId: string,
  input: CreateFeedbackBody,
  db: Queryable = getPool(),
): Promise<FeedbackRow> {
  const { rows } = await db.query<FeedbackRow>(
    `INSERT INTO feedback (
       recommendation_id, farmer_id, chosen_crop, actually_planted, outcome, lab_test
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.recommendation_id,
      farmerId,
      input.chosen_crop ?? null,
      input.actually_planted ?? null,
      input.outcome ?? null,
      input.lab_test ?? null,
    ],
  );
  return rows[0];
}
