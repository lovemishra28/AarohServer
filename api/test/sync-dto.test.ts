import { describe, expect, it } from 'vitest';
import {
  SyncBatchSchema,
  screenSyncBatch,
  type SyncBatchBody,
} from '../src/modules/segregation/segregation.dto';
import { MAX_SYNC_READINGS } from '../src/modules/segregation/segregation.config';
import {
  multiPointWkt,
  pointWkt,
} from '../src/modules/segregation/segregation.repo';

/**
 * The sync endpoint is the seam between firmware and the database, so these tests
 * are mostly about the ways hardware lies: a probe lifted out of the soil, a GPS
 * module with no fix, a frame with an identity and no numbers. The rule under test
 * throughout is that one bad reading must never cost the farmer the other
 * eighty-nine.
 */

const good = {
  idempotency_key: 'scan-1',
  taken_at: '2026-08-29T06:30:00.000Z',
  session_id: 'A-0829',
  lat: 26.2183,
  lng: 78.1828,
  n_mgkg: 120,
  p_mgkg: 9.4,
  k_mgkg: 140,
  ph: 7.4,
  ec_uscm: 310,
  moisture_vwc: 22.5,
  soil_temp_c: 27.1,
  raw_frame: 'ID:P123,N:120,P:9.4,K:140',
};

/** Parse through the schema so the tests exercise the real coercion path. */
function parse(readings: unknown[], device?: unknown): SyncBatchBody {
  const result = SyncBatchSchema.safeParse({ readings, ...(device ? { device } : {}) });
  if (!result.success) throw new Error(`fixture failed to parse: ${result.error.message}`);
  return result.data;
}

describe('SyncBatchSchema', () => {
  it('accepts a complete reading', () => {
    expect(SyncBatchSchema.safeParse({ readings: [good] }).success).toBe(true);
  });

  it('requires an idempotency key', () => {
    const { idempotency_key: _omitted, ...rest } = good;
    expect(SyncBatchSchema.safeParse({ readings: [rest] }).success).toBe(false);
  });

  it('accepts a non-UUID session id, because firmware sends things like A-0829', () => {
    const parsed = parse([{ ...good, session_id: 'A-0829' }]);
    expect(parsed.readings[0].session_id).toBe('A-0829');
  });

  it('accepts nulls for values the frame omitted', () => {
    const parsed = parse([{ ...good, soil_temp_c: null, ec_uscm: null }]);
    expect(parsed.readings[0].soil_temp_c).toBeNull();
  });

  it('rejects an empty batch and one over the cap', () => {
    expect(SyncBatchSchema.safeParse({ readings: [] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_SYNC_READINGS + 1 }, (_, i) => ({
      ...good,
      idempotency_key: `scan-${i}`,
    }));
    expect(SyncBatchSchema.safeParse({ readings: tooMany }).success).toBe(false);
  });

  it('rejects a non-numeric value outright — that is an app bug, not a bad probe', () => {
    expect(SyncBatchSchema.safeParse({ readings: [{ ...good, ph: '7.4' }] }).success).toBe(false);
    expect(SyncBatchSchema.safeParse({ readings: [{ ...good, ph: NaN }] }).success).toBe(false);
  });

  it('takes the device serial and firmware separately from the readings', () => {
    const parsed = parse([good], { serial: 'P123', firmware_version: '1.0.2' });
    expect(parsed.device?.serial).toBe('P123');
  });
});

describe('screenSyncBatch', () => {
  it('passes a good reading through unchanged, with taken_at parsed to a Date', () => {
    const { accepted, rejected, warnings } = screenSyncBatch(parse([good]));
    expect(rejected).toEqual([]);
    expect(warnings).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].taken_at.toISOString()).toBe('2026-08-29T06:30:00.000Z');
    expect(accepted[0].n_mgkg).toBe(120);
  });

  it('defaults a missing timestamp to now rather than dropping the reading', () => {
    const { taken_at: _omitted, ...rest } = good;
    const before = Date.now();
    const { accepted } = screenSyncBatch(parse([rest]));
    expect(accepted[0].taken_at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('drops a reading whose pH is outside the storable range, keeping the rest', () => {
    // The exact hardware failure this guards: the probe lifted out of the soil, so
    // pH reads 0.4. The database CHECK would refuse it and abort the transaction,
    // taking the good readings with it.
    const batch = parse([
      good,
      { ...good, idempotency_key: 'scan-2', ph: 0.4 },
      { ...good, idempotency_key: 'scan-3' },
    ]);
    const { accepted, rejected } = screenSyncBatch(batch);

    expect(accepted.map((r) => r.idempotency_key)).toEqual(['scan-1', 'scan-3']);
    expect(rejected).toEqual([{ idempotency_key: 'scan-2', reason: 'ph_out_of_range' }]);
  });

  it('drops negative nutrient and EC values', () => {
    const batch = parse([
      { ...good, idempotency_key: 'n', n_mgkg: -1 },
      { ...good, idempotency_key: 'ec', ec_uscm: -0.5 },
    ]);
    const { accepted, rejected } = screenSyncBatch(batch);
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(['negative_value', 'negative_value']);
  });

  it('drops impossible moisture and temperature', () => {
    const batch = parse([
      { ...good, idempotency_key: 'm', moisture_vwc: 140 },
      { ...good, idempotency_key: 't', soil_temp_c: 900 },
    ]);
    const { rejected } = screenSyncBatch(batch);
    expect(rejected.map((r) => r.reason)).toEqual([
      'moisture_out_of_range',
      'temperature_implausible',
    ]);
  });

  it('drops a frame that carries an identity but no measurements', () => {
    const batch = parse([
      {
        idempotency_key: 'empty',
        lat: 26.2,
        lng: 78.1,
        n_mgkg: null,
        p_mgkg: null,
        k_mgkg: null,
        ph: null,
        ec_uscm: null,
        moisture_vwc: null,
        soil_temp_c: null,
      },
    ]);
    const { accepted, rejected } = screenSyncBatch(batch);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ idempotency_key: 'empty', reason: 'no_values' }]);
  });

  it('keeps a reading with values but no GPS — it can inherit its session field', () => {
    const batch = parse([{ ...good, lat: null, lng: null }]);
    const { accepted, warnings } = screenSyncBatch(batch);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].lat).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('treats a null-island fix as no fix, and still stores the measurement', () => {
    // A GPS module with no lock reports exactly 0,0 — the Gulf of Guinea. Storing
    // it would put a field in the ocean and stretch the farmer's map to reach it.
    const batch = parse([{ ...good, lat: 0, lng: 0 }]);
    const { accepted, warnings } = screenSyncBatch(batch);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].lat).toBeNull();
    expect(accepted[0].lng).toBeNull();
    expect(accepted[0].n_mgkg).toBe(120);
    expect(warnings).toEqual([{ idempotency_key: 'scan-1', reason: 'gps_null_island' }]);
  });

  it('discards half a coordinate pair as a position but keeps the reading', () => {
    const batch = parse([{ ...good, lng: null }]);
    const { accepted, warnings } = screenSyncBatch(batch);
    expect(accepted[0].lat).toBeNull();
    expect(warnings).toEqual([{ idempotency_key: 'scan-1', reason: 'partial_coordinates' }]);
  });

  it('rejects coordinates outside the globe', () => {
    const batch = parse([{ ...good, lat: 91 }]);
    const { rejected } = screenSyncBatch(batch);
    expect(rejected).toEqual([
      { idempotency_key: 'scan-1', reason: 'coordinates_out_of_range' },
    ]);
  });

  it('accepts the pH range boundaries exactly, matching the database CHECK', () => {
    const batch = parse([
      { ...good, idempotency_key: 'lo', ph: 3 },
      { ...good, idempotency_key: 'hi', ph: 10 },
    ]);
    expect(screenSyncBatch(batch).accepted).toHaveLength(2);
  });
});

describe('WKT generation', () => {
  it('writes longitude before latitude', () => {
    expect(pointWkt({ lat: 26.2183, lng: 78.1828 })).toBe('POINT(78.1828000 26.2183000)');
  });

  it('writes a multipoint without per-point parentheses', () => {
    expect(multiPointWkt([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }])).toBe(
      'MULTIPOINT(2.0000000 1.0000000, 4.0000000 3.0000000)',
    );
  });

  it('refuses non-finite coordinates instead of emitting invalid WKT', () => {
    expect(() => pointWkt({ lat: Number.NaN, lng: 0 })).toThrow(/non-finite/);
  });

  it('refuses an empty point set', () => {
    expect(() => multiPointWkt([])).toThrow(/at least one point/);
  });
});
