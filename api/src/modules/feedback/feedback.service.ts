import { type AuthContext, assertOwnership } from '../../common/auth-middleware';
import { AppError } from '../../common/errors';
import { logger } from '../../common/logger';
import type { CreateFeedbackBody } from './feedback.dto';
import {
  type PublicFeedback,
  findRecommendationOwner,
  insertFeedback,
  toPublicFeedback,
} from './feedback.repo';

/**
 * POST /v1/feedback — record ground truth for a recommendation (§6.2). The
 * recommendation must exist and belong to a field the caller owns (agents/admins
 * may act on behalf of any farmer). The feedback is always attributed to the
 * field's owning farmer, not to the acting agent, so the calibration signal
 * stays tied to the right plot.
 */
export async function createFeedback(
  auth: AuthContext,
  input: CreateFeedbackBody,
): Promise<PublicFeedback> {
  const ownerFarmerId = await findRecommendationOwner(input.recommendation_id);
  if (!ownerFarmerId) {
    throw new AppError('RECOMMENDATION_NOT_FOUND', 'Recommendation not found', 404);
  }
  assertOwnership(ownerFarmerId, auth);

  const row = await insertFeedback(ownerFarmerId, input);
  logger.info('feedback_recorded', {
    feedback_id: row.id,
    recommendation_id: input.recommendation_id,
  });
  return toPublicFeedback(row);
}
