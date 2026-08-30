/**
 * Tunables for automated field segregation, in one place because these numbers
 * decide how a farmer's land is carved up and will need adjusting once real walks
 * exist to check them against.
 *
 * Every value is a distance in metres, chosen against the way the probe is
 * actually used: the farmer walks a plot and takes a reading every few paces, so
 * consecutive points are tens of metres apart, and separate plots — even adjacent
 * ones — are separated by a bund, a track or a canal.
 */

/**
 * DBSCAN neighbourhood radius. Two readings within this distance are treated as
 * the same plot.
 *
 * 40 m is deliberately generous. The cost of it being too small is far worse than
 * too large: too small splits one field into three, which shows the farmer three
 * fertility profiles for one plot and three sets of fertiliser advice. Too large
 * merges two genuinely different plots, which is visible immediately (one field
 * with an implausible area) and recoverable by lowering this number. Consumer GPS
 * on a phone is accurate to 5–15 m under open sky, so anything below ~25 m would
 * be clustering the noise rather than the land.
 */
export const CLUSTER_EPS_M = 40;

/**
 * Points needed to seed a cluster. Three is the minimum that can describe an
 * area at all — two points are a line — and it also means a single stray reading
 * taken beside the road never becomes a field on its own.
 */
export const CLUSTER_MIN_POINTS = 3;

/**
 * How close a cluster has to be to an existing field to be considered the same
 * field. Wider than `CLUSTER_EPS_M` on purpose: the stored boundary is the hull of
 * *previous* readings, which under-covers the real plot, so a new walk along the
 * far edge can legitimately sit 100 m from anything measured before.
 */
export const FIELD_MATCH_RADIUS_M = 120;

/**
 * Outward buffer applied to a computed hull. A walk samples the interior of a
 * plot, never its fence line, so the raw hull always understates the field. A few
 * metres of growth keeps the next walk's edge points inside the boundary instead
 * of just outside it, which is what makes containment matching stable.
 */
export const HULL_BUFFER_M = 4;

/**
 * Buffer used when the points cannot form a polygon at all — one point, two
 * points, or a perfectly straight walk. The result is a capsule around the
 * samples: honest about how little is known, and still a valid polygon with a
 * positive area, which the `area_ha > 0` CHECK requires.
 */
export const DEGENERATE_BUFFER_M = 8;

/**
 * `ST_ConcaveHull` convexity target: 1.0 is the convex hull, lower is more
 * concave. 0.85 lets an L-shaped or curved plot keep its shape without inventing
 * the spidery outline a low value produces from sparse points. The result is only
 * used if it stays a valid polygon retaining most of the convex hull's area
 * (see `HULL_MIN_AREA_RATIO`).
 */
export const CONCAVE_HULL_TARGET = 0.85;

/** A concave hull keeping less of the convex hull's area than this is discarded. */
export const HULL_MIN_AREA_RATIO = 0.5;

/**
 * Minimum points before a concave hull is attempted. Below this a concave hull is
 * either identical to the convex hull or a degenerate sliver.
 */
export const CONCAVE_HULL_MIN_POINTS = 5;

/** Upper bound on one sync. The stick stores far less; this is a sanity limit. */
export const MAX_SYNC_READINGS = 500;
