import { type AuthContext } from '../../common/auth-middleware';
import { AppError } from '../../common/errors';
import { logger } from '../../common/logger';
import {
  type AiFeatures,
  type RecommendationResult,
  requestRecommendation,
} from '../../common/ai-client';
import { defaultAgroContext } from '../../config/context-defaults';
import type { FieldRow } from '../fields/fields.repo';
import { getOwnedFieldOrThrow } from '../fields/fields.service';
import {
  type ReadingRow,
  findLatestReadingForField,
  findReadingById,
  isFieldNpkCalibrated,
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
 * The soil numbers a recommendation is computed from, independent of where they
 * came from. Two things can fill this: one stored reading, or the field's mean
 * across every reading it holds.
 *
 * The distinction matters agronomically. A single probe hole measures one spot; a
 * field's fertiliser plan is for the whole field. Once a walk has produced thirty
 * points, the mean is the better estimate of what the plot needs, and using the
 * *latest* reading instead would make the advice depend on wherever the farmer
 * happened to stop walking.
 */
interface SoilValues {
  n_mgkg: number | null;
  p_mgkg: number | null;
  k_mgkg: number | null;
  ph: number | null;
  ec_uscm: number | null;
  moisture_vwc: number | null;
  soil_temp_c: number | null;
  npk_is_calibrated: boolean;
}

function soilFromReading(row: ReadingRow): SoilValues {
  return {
    n_mgkg: toNum(row.n_mgkg),
    p_mgkg: toNum(row.p_mgkg),
    k_mgkg: toNum(row.k_mgkg),
    ph: toNum(row.ph),
    ec_uscm: toNum(row.ec_uscm),
    moisture_vwc: toNum(row.moisture_vwc),
    soil_temp_c: toNum(row.soil_temp_c),
    npk_is_calibrated: row.npk_is_calibrated,
  };
}

function soilFromFieldAverage(field: FieldRow, npkIsCalibrated: boolean): SoilValues {
  return {
    n_mgkg: toNum(field.agg_n_mgkg),
    p_mgkg: toNum(field.agg_p_mgkg),
    k_mgkg: toNum(field.agg_k_mgkg),
    ph: toNum(field.agg_ph),
    ec_uscm: toNum(field.agg_ec_uscm),
    moisture_vwc: toNum(field.agg_moisture_vwc),
    soil_temp_c: toNum(field.agg_soil_temp_c),
    npk_is_calibrated: npkIsCalibrated,
  };
}

/** Does this source carry every soil value the engine requires? */
function isComplete(soil: SoilValues): boolean {
  return REQUIRED_READING_FIELDS.every(({ col }) => soil[col] !== null);
}

/**
 * Turn soil values + request overrides into the exact feature payload the Python
 * service expects. Throws READING_INCOMPLETE (422) listing every missing soil
 * field so the caller knows precisely what to re-measure.
 */
function buildFeatures(soil: SoilValues, body: CreateRecommendationBody): AiFeatures {
  const missing: string[] = [];
  const values: Record<string, number> = {};
  for (const { col, feature } of REQUIRED_READING_FIELDS) {
    const n = soil[col];
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
  if (soil.soil_temp_c !== null) features.temperature = soil.soil_temp_c;
  return features;
}

/**
 * The money path (§6.2, §10). Resolve an owned field and a soil source, assemble
 * the feature payload, call the private Python service, persist the §6.4 result
 * with the versions that produced it, and return it.
 *
 * How the soil source is chosen, in order:
 *
 * 1. `reading_id` — an explicit pin, always honoured.
 * 2. `basis: 'latest_reading'` — the caller wants one spot, not the field.
 * 3. The **field mean**, when the field holds two or more readings and the mean is
 *    complete. This is the default because it is the number the dashboard shows;
 *    advice that disagreed with the figures on screen would be indefensible.
 * 4. The latest reading, for a field with a single reading or an incomplete mean.
 *
 * A stored recommendation records `reading_id = NULL` when it came from the mean.
 * That is deliberate rather than a convenience: pointing it at an arbitrary
 * contributing reading would misstate, permanently, what the advice was based on.
 */
export async function createRecommendation(
  auth: AuthContext,
  fieldId: string,
  body: CreateRecommendationBody,
): Promise<PublicRecommendation> {
  const field = await getOwnedFieldOrThrow(auth, fieldId);

  let reading: ReadingRow | null = null;
  let soil: SoilValues | null = null;
  let basis: 'reading' | 'field_average' = 'reading';

  if (body.reading_id) {
    reading = await findReadingById(body.reading_id);
    if (!reading || reading.field_id !== fieldId) {
      throw new AppError('READING_NOT_FOUND', 'Reading not found for this field', 404);
    }
    soil = soilFromReading(reading);
  } else if (body.basis !== 'latest_reading' && (field.agg_reading_count ?? 0) >= 2) {
    const candidate = soilFromFieldAverage(field, await isFieldNpkCalibrated(fieldId));
    if (isComplete(candidate)) {
      soil = candidate;
      basis = 'field_average';
    }
  }

  if (!soil) {
    reading = await findLatestReadingForField(fieldId);
    if (!reading) {
      throw new AppError(
        'NO_READING',
        'This field has no readings yet; record a soil reading first.',
        422,
      );
    }
    soil = soilFromReading(reading);
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

  const features = buildFeatures(soil, body);

  const result: RecommendationResult = await requestRecommendation({
    features,
    region_code: field.region_code,
    area_ha: areaHa,
    npk_is_calibrated: soil.npk_is_calibrated,
    ...(body.budget_hint !== undefined ? { budget_hint: body.budget_hint } : {}),
  });

  const row = await insertRecommendation({
    field_id: fieldId,
    reading_id: basis === 'field_average' ? null : (reading?.id ?? null),
    model_version: result.model_version,
    agronomy_version: result.agronomy_version,
    region_code: field.region_code,
    area_ha: areaHa,
    result,
  });

  logger.info('recommendation_created', {
    field_id: fieldId,
    basis,
    reading_id: basis === 'field_average' ? null : (reading?.id ?? null),
    reading_count: field.agg_reading_count ?? 0,
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
