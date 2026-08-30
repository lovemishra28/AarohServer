import { z } from 'zod';
import { MAX_SYNC_READINGS } from './segregation.config';
import type { SyncReading } from './segregation.service';

/**
 * The wire shape of a stick sync, and the screening that decides which readings
 * are physically believable.
 *
 * The split between the two is deliberate. Zod checks *structure* — is this a
 * number, is the key present, is the array a sane length — and a structural
 * failure rejects the request, because it means the app is broken. Physical
 * plausibility is checked afterwards, per reading, and a failure there rejects
 * only that reading.
 *
 * That asymmetry exists because of how the hardware fails. A probe pulled out of
 * the soil mid-walk reports pH 0.4 and EC 0; the database CHECK (`ph BETWEEN 3 AND
 * 10`) would refuse it, and since the whole sync is one transaction, that single
 * bad row would abort the other 89 good readings — losing the walk to protect
 * nothing. So screening happens first, in application code, and the response tells
 * the farmer's app exactly which readings were dropped and why.
 */

/**
 * Reading fields are typed but not range-checked here: ranges are screened per
 * reading below. `.nullable().optional()` because the app sends `null` for a value
 * the frame omitted, and omits the key entirely for one the firmware never sends.
 */
const metric = z.number().finite().nullable().optional();

export const SyncReadingSchema = z.object({
  /**
   * The app's stored scan id. Required — without it a dropped response means the
   * next retry duplicates the whole walk.
   */
  idempotency_key: z.string().trim().min(1).max(200),
  taken_at: z.string().datetime().optional(),
  /** The stick's `SID`. Free text, not a UUID: firmware sends things like `A-0829`. */
  session_id: z.string().trim().min(1).max(120).nullable().optional(),
  lat: metric,
  lng: metric,
  n_mgkg: metric,
  p_mgkg: metric,
  k_mgkg: metric,
  ph: metric,
  ec_uscm: metric,
  moisture_vwc: metric,
  soil_temp_c: metric,
  raw_frame: z.string().max(2000).nullable().optional(),
});

export const SyncBatchSchema = z.object({
  device: z
    .object({
      /** The stick's `ID` — `devices.serial`. */
      serial: z.string().trim().min(1).max(120).nullable().optional(),
      firmware_version: z.string().trim().max(50).nullable().optional(),
    })
    .optional(),
  readings: z.array(SyncReadingSchema).min(1).max(MAX_SYNC_READINGS),
});

export type SyncReadingBody = z.infer<typeof SyncReadingSchema>;
export type SyncBatchBody = z.infer<typeof SyncBatchSchema>;

/** Why a reading was dropped. Stable codes — the app maps them to Hindi strings. */
export type SyncRejectReason =
  | 'no_values'
  | 'ph_out_of_range'
  | 'negative_value'
  | 'moisture_out_of_range'
  | 'temperature_implausible'
  | 'coordinates_out_of_range';

export interface SyncReject {
  idempotency_key: string;
  reason: SyncRejectReason;
}

/** Something was adjusted rather than dropped. The reading is still stored. */
export type SyncWarningReason = 'gps_null_island' | 'partial_coordinates';

export interface SyncWarning {
  idempotency_key: string;
  reason: SyncWarningReason;
}

export interface ScreenedBatch {
  accepted: SyncReading[];
  rejected: SyncReject[];
  warnings: SyncWarning[];
}

/**
 * Physical bounds. The pH and EC limits mirror the database CHECKs exactly — if
 * they ever drift apart, the strict one wins and the sync fails on insert, so they
 * are stated here as the single reason a reading is dropped for pH.
 */
const PH_MIN = 3;
const PH_MAX = 10;
const MOISTURE_MAX = 100;
const SOIL_TEMP_MIN_C = -20;
const SOIL_TEMP_MAX_C = 80;

const isNum = (v: number | null | undefined): v is number => typeof v === 'number';

/**
 * Screen a parsed batch into what can be stored and what cannot.
 *
 * Two coordinate cases are corrected rather than rejected, because in both the
 * *measurement* is fine and only the position is missing:
 *
 * - **Null island.** A GPS module with no fix reports exactly 0°, 0° — a spot in
 *   the Gulf of Guinea. Storing it would put a field in the ocean and drag the
 *   farmer's map with it, so the position is discarded and the reading is treated
 *   as GPS-less, which means it can still inherit its session's field.
 * - **One coordinate without the other.** Meaningless as a position; same
 *   treatment.
 */
export function screenSyncBatch(body: SyncBatchBody): ScreenedBatch {
  const accepted: SyncReading[] = [];
  const rejected: SyncReject[] = [];
  const warnings: SyncWarning[] = [];

  for (const r of body.readings) {
    const key = r.idempotency_key;

    const values = [r.n_mgkg, r.p_mgkg, r.k_mgkg, r.ph, r.ec_uscm, r.moisture_vwc, r.soil_temp_c];
    if (!values.some(isNum)) {
      rejected.push({ idempotency_key: key, reason: 'no_values' });
      continue;
    }
    if (isNum(r.ph) && (r.ph < PH_MIN || r.ph > PH_MAX)) {
      rejected.push({ idempotency_key: key, reason: 'ph_out_of_range' });
      continue;
    }
    if (
      [r.n_mgkg, r.p_mgkg, r.k_mgkg, r.ec_uscm, r.moisture_vwc].some((v) => isNum(v) && v < 0)
    ) {
      rejected.push({ idempotency_key: key, reason: 'negative_value' });
      continue;
    }
    if (isNum(r.moisture_vwc) && r.moisture_vwc > MOISTURE_MAX) {
      rejected.push({ idempotency_key: key, reason: 'moisture_out_of_range' });
      continue;
    }
    if (
      isNum(r.soil_temp_c) &&
      (r.soil_temp_c < SOIL_TEMP_MIN_C || r.soil_temp_c > SOIL_TEMP_MAX_C)
    ) {
      rejected.push({ idempotency_key: key, reason: 'temperature_implausible' });
      continue;
    }

    let lat = isNum(r.lat) ? r.lat : null;
    let lng = isNum(r.lng) ? r.lng : null;

    if (lat !== null && lng !== null && (Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
      rejected.push({ idempotency_key: key, reason: 'coordinates_out_of_range' });
      continue;
    }
    if (lat === 0 && lng === 0) {
      warnings.push({ idempotency_key: key, reason: 'gps_null_island' });
      lat = null;
      lng = null;
    } else if ((lat === null) !== (lng === null)) {
      warnings.push({ idempotency_key: key, reason: 'partial_coordinates' });
      lat = null;
      lng = null;
    }

    accepted.push({
      idempotency_key: key,
      // No timestamp means the app could not read one off the frame; the moment it
      // reached the server is the closest honest answer.
      taken_at: r.taken_at ? new Date(r.taken_at) : new Date(),
      session_id: r.session_id ?? null,
      lat,
      lng,
      n_mgkg: isNum(r.n_mgkg) ? r.n_mgkg : null,
      p_mgkg: isNum(r.p_mgkg) ? r.p_mgkg : null,
      k_mgkg: isNum(r.k_mgkg) ? r.k_mgkg : null,
      ph: isNum(r.ph) ? r.ph : null,
      ec_uscm: isNum(r.ec_uscm) ? r.ec_uscm : null,
      moisture_vwc: isNum(r.moisture_vwc) ? r.moisture_vwc : null,
      soil_temp_c: isNum(r.soil_temp_c) ? r.soil_temp_c : null,
      raw_frame: r.raw_frame ?? null,
    });
  }

  return { accepted, rejected, warnings };
}
