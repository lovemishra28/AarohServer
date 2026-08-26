import { type AuthContext } from '../../common/auth-middleware';
import { AppError } from '../../common/errors';
import { logger } from '../../common/logger';
import {
  type AiFeatures,
  type RecommendationResult,
  requestRecommendation,
} from '../../common/ai-client';
import { defaultAgroContext } from '../../config/context-defaults';
import { getOwnedFieldOrThrow } from '../fields/fields.service';
import {
  type ReadingRow,
  findLatestReadingForField,
  findReadingById,
} from '../readings/readings.repo';
import type { CreateRecommendationBody } from './recommendations.dto';
import {
  type PublicRecommendation,
  insertRecommendation,
  listRecommendationsForField,
  toPublicRecommendation,
} from './recommendations.repo';

/**
 * The soil-chemistry columns the Python `Features` model treats as required
 * (§6.3). Everything else it needs — humidity, rainfall, soil_type, season — is
 * supplied from context, and `temperature` is optional. A reading missing any of
 * these cannot produce a trustworthy recommendation, so we refuse rather than
 * silently substituting zeros (which would corrupt the nutrient-gap maths).
 */
const REQUIRED_READING_FIELDS = [
  { col: 'n_mgkg', feature: 'N' },
  { col: 'p_mgkg', feature: 'P' },
  { col: 'k_mgkg', feature: 'K' },
  { col: 'ph', feature: 'ph' },
  { col: 'ec_uscm', feature: 'ec' },
  { col: 'moisture_vwc', feature: 'moisture' },
] as const;

/** Parse a `numeric` column (string | null) to a finite number, else null. */
function toNum(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn a stored reading + request overrides into the exact feature payload the
 * Python service expects. Throws READING_INCOMPLETE (422) listing every missing
 * soil field so the caller knows precisely what to re-measure.
 */
function buildFeatures(reading: ReadingRow, body: CreateRecommendationBody): AiFeatures {
  const missing: string[] = [];
  const values: Record<string, number> = {};
  for (const { col, feature } of REQUIRED_READING_FIELDS) {
    const n = toNum(reading[col]);
    if (n === null) missing.push(col);
    else values[feature] = n;
  }
  if (missing.length > 0) {
    throw new AppError(
      'READING_INCOMPLETE',
      'The reading is missing soil measurements required for a recommendation.',
      422,
      { missing },
    );
  }

  const ctx = defaultAgroContext();
  const soilTempC = toNum(reading.soil_temp_c);

  const features: AiFeatures = {
    N: values.N,
    P: values.P,
    K: values.K,
    ph: values.ph,
    ec: values.ec,
    moisture: values.moisture,
    humidity: body.humidity ?? ctx.humidity,
    rainfall: body.rainfall ?? ctx.rainfall,
    soil_type: body.soil_type ?? ctx.soil_type,
    season: body.season ?? ctx.season,
  };
  // temperature is optional in the contract; only include it when measured.
  if (soilTempC !== null) features.temperature = soilTempC;
  return features;
}

/**
 * The money path (§6.2, §10). Resolve an owned field and a reading, assemble the
 * feature payload, call the private Python service, persist the §6.4 result with
 * the versions that produced it, and return it.
 */
export async function createRecommendation(
  auth: AuthContext,
  fieldId: string,
  body: CreateRecommendationBody,
): Promise<PublicRecommendation> {
  const field = await getOwnedFieldOrThrow(auth, fieldId);

  // Resolve the reading: an explicit id (must belong to this field) or the
  // field's latest.
  let reading: ReadingRow | null;
  if (body.reading_id) {
    reading = await findReadingById(body.reading_id);
    if (!reading || reading.field_id !== fieldId) {
      throw new AppError('READING_NOT_FOUND', 'Reading not found for this field', 404);
    }
  } else {
    reading = await findLatestReadingForField(fieldId);
    if (!reading) {
      throw new AppError(
        'NO_READING',
        'This field has no readings yet; record a soil reading first.',
        422,
      );
    }
  }

  // Area drives the cost scaling. Prefer an explicit override, then the field's
  // stored area; refuse if neither is known (a cost with no area is meaningless).
  const areaHa = body.area_ha ?? toNum(field.area_ha) ?? null;
  if (areaHa === null) {
    throw new AppError(
      'AREA_REQUIRED',
      'No area is set for this field; supply area_ha to size the recommendation.',
      422,
    );
  }

  const features = buildFeatures(reading, body);

  const result: RecommendationResult = await requestRecommendation({
    features,
    region_code: field.region_code,
    area_ha: areaHa,
    npk_is_calibrated: reading.npk_is_calibrated,
    ...(body.budget_hint !== undefined ? { budget_hint: body.budget_hint } : {}),
  });

  const row = await insertRecommendation({
    field_id: fieldId,
    reading_id: reading.id,
    model_version: result.model_version,
    agronomy_version: result.agronomy_version,
    region_code: field.region_code,
    area_ha: areaHa,
    result,
  });

  logger.info('recommendation_created', {
    field_id: fieldId,
    reading_id: reading.id,
    model_version: result.model_version,
    agronomy_version: result.agronomy_version,
  });

  return toPublicRecommendation(row);
}

/** GET /v1/fields/:id/recommendations — the field's saved recommendations. */
export async function listRecommendations(
  auth: AuthContext,
  fieldId: string,
  limit = 50,
): Promise<PublicRecommendation[]> {
  await getOwnedFieldOrThrow(auth, fieldId);
  const rows = await listRecommendationsForField(fieldId, limit);
  return rows.map(toPublicRecommendation);
}
