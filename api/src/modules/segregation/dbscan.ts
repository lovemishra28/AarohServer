/**
 * DBSCAN over GPS points, in metres.
 *
 * **Why this is TypeScript and not `ST_ClusterDBSCAN`.** PostGIS has a DBSCAN
 * window function, and it is the obvious tool — but it clusters in the units of
 * the geometry it is given. For SRID 4326 that unit is *degrees*, where one degree
 * of longitude is 111 km at the equator and 100 km at Gwalior, so an `eps`
 * expressed in degrees means a different distance for every farmer. The usual
 * workaround, transforming to 3857 first, trades that for a latitude-dependent
 * scale error of about 11% at 26°N — small, but it silently changes the meaning of
 * a tuning parameter that decides whether two fields are one field.
 *
 * Clustering here, on haversine metres, keeps `eps` literal: 40 metres means 40
 * metres in Chambal and in Kerala. It also makes the decision that shapes every
 * downstream field record testable without a database — which matters, because
 * the failure mode of bad clustering is not an error, it is two of a farmer's
 * fields quietly becoming one.
 *
 * PostGIS still does the geometry that geometry is good at: hulls, areas,
 * containment and nearest-field matching (see `segregation.repo.ts`). This module
 * only answers "which of these points belong together".
 *
 * The implementation is textbook DBSCAN (Ester et al., 1996) with an O(n²) region
 * query. A sync is capped at 500 readings, so that is at most 250k distance
 * calculations — microseconds, and not worth the complexity of a spatial index.
 */

/** Any object with a GPS fix. Callers pass their own rows and get indices back. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface DbscanOptions {
  /** Neighbourhood radius in metres. Two points closer than this are reachable. */
  epsMeters: number;
  /**
   * Minimum points (including the point itself) for a core point. Below this a
   * point can still join a cluster as a border point, but cannot seed one.
   */
  minPoints: number;
}

export interface DbscanResult {
  /** Indices into the input array, one array per cluster, in first-seen order. */
  clusters: number[][];
  /** Indices that belong to no cluster — a lone reading, a GPS outlier. */
  noise: number[];
}

const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres. Haversine rather than a projected
 * approximation because it is exact enough at every scale we care about (metres
 * within a field, kilometres between fields) and has no per-region setup.
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Mean position. At field scale the error from averaging degrees is millimetres. */
export function centroidOf(points: readonly GeoPoint[]): GeoPoint {
  if (points.length === 0) throw new Error('centroidOf: no points');
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

/** Largest distance from the centroid — how spread out a cluster is, in metres. */
export function spreadMeters(points: readonly GeoPoint[]): number {
  if (points.length < 2) return 0;
  const c = centroidOf(points);
  let max = 0;
  for (const p of points) max = Math.max(max, haversineMeters(c, p));
  return max;
}

/** Largest distance between any two points — the cluster's diameter, in metres. */
export function diameterMeters(points: readonly GeoPoint[]): number {
  let max = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      max = Math.max(max, haversineMeters(points[i], points[j]));
    }
  }
  return max;
}

const UNVISITED = -2;
const NOISE = -1;

/**
 * Group points into clusters of points within `epsMeters` of one another.
 *
 * Determinism is a requirement, not an accident: points are visited in input
 * order and neighbours are appended in index order, so the same batch always
 * produces the same clusters in the same order. A sync that produced "Field 2"
 * and "Field 3" in a different order on a retry would create duplicate fields.
 *
 * Note what DBSCAN does *not* do: it never forces every point into a cluster. A
 * single reading taken on the way to the field is noise, and the caller decides
 * what to do with it (see `segregation.service.ts`, which tries to attach it to
 * an existing field and otherwise leaves it unassigned rather than inventing a
 * one-point field).
 */
export function dbscan(points: readonly GeoPoint[], options: DbscanOptions): DbscanResult {
  const { epsMeters, minPoints } = options;
  if (!(epsMeters > 0)) throw new Error('dbscan: epsMeters must be positive');
  if (!(minPoints >= 1)) throw new Error('dbscan: minPoints must be at least 1');

  const labels = new Array<number>(points.length).fill(UNVISITED);
  const clusters: number[][] = [];

  const neighbours = (index: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < points.length; i += 1) {
      if (haversineMeters(points[index], points[i]) <= epsMeters) out.push(i);
    }
    return out;
  };

  for (let seed = 0; seed < points.length; seed += 1) {
    if (labels[seed] !== UNVISITED) continue;

    const seedNeighbours = neighbours(seed);
    if (seedNeighbours.length < minPoints) {
      // Not a core point. It may still be picked up later as a border point of
      // another cluster, which is why this is provisional rather than final.
      labels[seed] = NOISE;
      continue;
    }

    const clusterId = clusters.length;
    const members: number[] = [];
    labels[seed] = clusterId;
    members.push(seed);

    // Breadth-first expansion. `queue` grows while we walk it; every core point
    // found contributes its own neighbourhood.
    const queue = seedNeighbours.slice();
    for (let q = 0; q < queue.length; q += 1) {
      const candidate = queue[q];
      if (labels[candidate] === NOISE) {
        // Border point: reachable from a core point but not core itself.
        labels[candidate] = clusterId;
        members.push(candidate);
        continue;
      }
      if (labels[candidate] !== UNVISITED) continue;

      labels[candidate] = clusterId;
      members.push(candidate);

      const candidateNeighbours = neighbours(candidate);
      if (candidateNeighbours.length >= minPoints) {
        for (const n of candidateNeighbours) {
          if (labels[n] === UNVISITED || labels[n] === NOISE) queue.push(n);
        }
      }
    }

    members.sort((a, b) => a - b);
    clusters.push(members);
  }

  const noise: number[] = [];
  for (let i = 0; i < labels.length; i += 1) if (labels[i] === NOISE) noise.push(i);

  return { clusters, noise };
}
