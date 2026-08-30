import { describe, expect, it } from 'vitest';
import {
  centroidOf,
  dbscan,
  diameterMeters,
  haversineMeters,
  spreadMeters,
  type GeoPoint,
} from '../src/modules/segregation/dbscan';
import {
  CLUSTER_EPS_M,
  CLUSTER_MIN_POINTS,
} from '../src/modules/segregation/segregation.config';

/**
 * Clustering decides how a farmer's land is divided, and it fails silently: a bad
 * `eps` does not throw, it merges two plots into one field and gives both the
 * average of the wrong soil. These tests pin the behaviour that matters — real
 * separations are found, GPS jitter is not mistaken for a new field, and the same
 * batch always produces the same answer.
 *
 * Distances are built from a metres-per-degree conversion rather than hand-picked
 * coordinates so the intent of each fixture is readable.
 */

/** Metres per degree of latitude, near enough anywhere. */
const M_PER_DEG_LAT = 111_320;
const BASE: GeoPoint = { lat: 26.2183, lng: 78.1828 }; // Gwalior, Chambal region.

/** A point `northM` metres north and `eastM` metres east of {@link BASE}. */
function at(northM: number, eastM: number): GeoPoint {
  const lat = BASE.lat + northM / M_PER_DEG_LAT;
  const lng = BASE.lng + eastM / (M_PER_DEG_LAT * Math.cos((BASE.lat * Math.PI) / 180));
  return { lat, lng };
}

const opts = { epsMeters: CLUSTER_EPS_M, minPoints: CLUSTER_MIN_POINTS };

describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters(BASE, BASE)).toBe(0);
  });

  it('matches the metres-per-degree construction to within a metre', () => {
    expect(haversineMeters(BASE, at(100, 0))).toBeCloseTo(100, 0);
    expect(haversineMeters(BASE, at(0, 100))).toBeCloseTo(100, 0);
  });

  it('is symmetric', () => {
    const a = at(30, 40);
    expect(haversineMeters(BASE, a)).toBeCloseTo(haversineMeters(a, BASE), 6);
  });

  it('measures longitude in metres, not degrees', () => {
    // The whole reason clustering is not done in SRID 4326 units: one degree of
    // longitude here is ~100 km, not ~111 km, so a degree-based eps would mean a
    // different distance at every latitude.
    const oneDegreeEast = { lat: BASE.lat, lng: BASE.lng + 1 };
    const metres = haversineMeters(BASE, oneDegreeEast);
    expect(metres).toBeGreaterThan(99_000);
    expect(metres).toBeLessThan(101_000);
  });
});

describe('dbscan', () => {
  it('finds two plots separated by a track', () => {
    // Two tight groups 300 m apart — a bund or a road between two fields.
    const points = [
      at(0, 0),
      at(10, 5),
      at(5, 12),
      at(0, 300),
      at(12, 305),
      at(6, 312),
    ];
    const { clusters, noise } = dbscan(points, opts);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toEqual([0, 1, 2]);
    expect(clusters[1]).toEqual([3, 4, 5]);
    expect(noise).toEqual([]);
  });

  it('keeps one plot together when readings are taken every few paces', () => {
    // A 200 m walk in 20 m steps: no two consecutive points exceed eps, so the
    // whole walk is one field even though its ends are 200 m apart.
    const points = Array.from({ length: 11 }, (_, i) => at(0, i * 20));
    const { clusters, noise } = dbscan(points, opts);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(11);
    expect(noise).toEqual([]);
  });

  it('does not split a plot over GPS jitter', () => {
    // Six readings of the same spot, scattered by up to ~12 m of consumer-GPS
    // error. This must be one cluster, never six one-point fields.
    const jitter = [at(0, 0), at(8, -4), at(-6, 9), at(3, 11), at(-11, -2), at(5, 5)];
    const { clusters, noise } = dbscan(jitter, opts);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(6);
    expect(noise).toEqual([]);
  });

  it('reports an isolated reading as noise rather than a field', () => {
    const points = [at(0, 0), at(9, 4), at(4, 10), at(0, 900)];
    const { clusters, noise } = dbscan(points, opts);

    expect(clusters).toEqual([[0, 1, 2]]);
    expect(noise).toEqual([3]);
  });

  it('treats a lone point as noise, not a cluster of one', () => {
    expect(dbscan([at(0, 0)], opts)).toEqual({ clusters: [], noise: [0] });
  });

  it('clusters identical coordinates once minPoints is met', () => {
    // A stationary probe taking repeat readings: distance zero between every
    // pair, which is a degenerate case for hull building downstream.
    const same = [at(0, 0), at(0, 0), at(0, 0)];
    expect(dbscan(same, opts)).toEqual({ clusters: [[0, 1, 2]], noise: [] });
  });

  it('does not cluster two identical points when minPoints is three', () => {
    const { clusters, noise } = dbscan([at(0, 0), at(0, 0)], opts);
    expect(clusters).toEqual([]);
    expect(noise).toEqual([0, 1]);
  });

  it('includes a border point that is reachable but not itself core', () => {
    // Three points inside eps of each other, plus one exactly reachable from the
    // last: it joins the cluster without being able to extend it.
    const points = [at(0, 0), at(0, 10), at(0, 20), at(0, 20 + CLUSTER_EPS_M - 1)];
    const { clusters, noise } = dbscan(points, opts);

    expect(clusters).toEqual([[0, 1, 2, 3]]);
    expect(noise).toEqual([]);
  });

  it('respects the eps boundary in both directions', () => {
    const inside = [at(0, 0), at(0, CLUSTER_EPS_M - 1), at(0, 2 * (CLUSTER_EPS_M - 1))];
    expect(dbscan(inside, opts).clusters).toHaveLength(1);

    const outside = [at(0, 0), at(0, CLUSTER_EPS_M + 5), at(0, 2 * (CLUSTER_EPS_M + 5))];
    expect(dbscan(outside, opts).clusters).toHaveLength(0);
  });

  it('is deterministic — the same batch yields the same clusters in the same order', () => {
    // Load-bearing: a retried sync that ordered clusters differently would match
    // them to different fields and create duplicates.
    const points = [at(0, 300), at(0, 0), at(11, 296), at(9, 6), at(4, 308), at(3, 9)];
    const first = dbscan(points, opts);
    const second = dbscan(points, opts);

    expect(second).toEqual(first);
    expect(first.clusters).toHaveLength(2);
    // First-seen order: the cluster containing input index 0 comes first.
    expect(first.clusters[0]).toContain(0);
  });

  it('handles an empty input', () => {
    expect(dbscan([], opts)).toEqual({ clusters: [], noise: [] });
  });

  it('rejects a non-positive eps', () => {
    expect(() => dbscan([at(0, 0)], { epsMeters: 0, minPoints: 3 })).toThrow(/epsMeters/);
  });

  it('finds three plots in a mock walk of the shape the app sends', () => {
    // The mock dataset's geometry: three plots a few hundred metres apart, each
    // walked as a loose grid. This is the case the end-to-end test exercises.
    const plots = [at(0, 0), at(0, 400), at(400, 200)];
    const points = plots.flatMap((origin) =>
      [
        [0, 0],
        [25, 0],
        [0, 25],
        [25, 25],
        [12, 12],
      ].map(([n, e]) => ({
        lat: origin.lat + n / M_PER_DEG_LAT,
        lng:
          origin.lng + e / (M_PER_DEG_LAT * Math.cos((BASE.lat * Math.PI) / 180)),
      })),
    );

    const { clusters, noise } = dbscan(points, opts);
    expect(clusters).toHaveLength(3);
    expect(clusters.map((c) => c.length)).toEqual([5, 5, 5]);
    expect(noise).toEqual([]);
  });
});

describe('cluster geometry helpers', () => {
  it('averages positions', () => {
    const c = centroidOf([at(0, 0), at(100, 0)]);
    expect(haversineMeters(c, at(50, 0))).toBeLessThan(1);
  });

  it('throws rather than returning a fake centroid for no points', () => {
    expect(() => centroidOf([])).toThrow(/no points/);
  });

  it('measures spread from the centroid and diameter between extremes', () => {
    const points = [at(0, 0), at(0, 100)];
    expect(spreadMeters(points)).toBeCloseTo(50, 0);
    expect(diameterMeters(points)).toBeCloseTo(100, 0);
  });

  it('reports zero spread and diameter for a single point', () => {
    expect(spreadMeters([at(0, 0)])).toBe(0);
    expect(diameterMeters([at(0, 0)])).toBe(0);
  });
});
