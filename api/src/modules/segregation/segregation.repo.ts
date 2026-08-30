import { getPool, type Queryable } from '../../common/db';
import { FIELD_SELECT_COLS, FIELD_SELECT_FROM, type FieldRow } from '../fields/fields.repo';
import type { GeoPoint } from './dbscan';
import {
  CONCAVE_HULL_MIN_POINTS,
  CONCAVE_HULL_TARGET,
  DEGENERATE_BUFFER_M,
  HULL_BUFFER_M,
  HULL_MIN_AREA_RATIO,
} from './segregation.config';

/**
 * The PostGIS half of field segregation: everything that is genuinely geometry.
 *
 * Clustering happens in TypeScript (see `dbscan.ts` for why), but once a group of
 * points exists, the questions that follow — what shape encloses them, how many
 * hectares is that, which existing field does it overlap — are exactly what
 * PostGIS is for, and re-implementing them here would be both slower and wrong at
 * the edges.
 *
 * Two invariants hold across this file.
 *
 * **Geometry is only ever derived for `source = 'auto'` fields.** A boundary the
 * farmer drew by hand is a statement about their land; a boundary inferred from
 * eight GPS points is a guess that improves as more points arrive. Confusing the
 * two would let a sync silently redraw something deliberate.
 *
 * **A boundary is never empty and never zero-area.** `fields.area_ha` carries a
 * `> 0` CHECK, and a single reading or a dead-straight walk produces a point or a
 * line, not a polygon. Every hull therefore ends in an outward buffer, so the
 * geometry a one-point field gets is an honest small circle rather than a
 * constraint violation.
 */

/**
 * Coordinate precision for generated WKT. Seven decimal places is ~11 mm at the
 * equator — far finer than any GPS fix, and short enough to keep a 100-point
 * MULTIPOINT literal small.
 */
const COORD_DP = 7;

function coord(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`segregation: non-finite coordinate ${n}`);
  return n.toFixed(COORD_DP);
}

/** `POINT(lng lat)` — WKT is x-then-y, i.e. longitude first. */
export function pointWkt(p: GeoPoint): string {
  return `POINT(${coord(p.lng)} ${coord(p.lat)})`;
}

/**
 * `MULTIPOINT(lng lat, lng lat, …)`, the input to every hull. Passed as a bound
 * parameter to `ST_GeomFromText`, never interpolated into SQL.
 */
export function multiPointWkt(points: readonly GeoPoint[]): string {
  if (points.length === 0) throw new Error('segregation: multiPointWkt needs at least one point');
  return `MULTIPOINT(${points.map((p) => `${coord(p.lng)} ${coord(p.lat)}`).join(', ')})`;
}

/**
 * The shared hull pipeline, as a CTE chain ending in `hull(boundary)`.
 *
 * `pointsExpr` is SQL yielding a single geometry holding all the points — either
 * `ST_GeomFromText($n, 4326)` for an incoming cluster or `ST_Collect(location)`
 * for a field being recomputed. Only config constants are interpolated; every
 * caller-supplied value stays a bound parameter.
 *
 * The cascade, in order:
 *
 * 1. **Concave hull**, attempted only with enough points to make it meaningful.
 *    It is kept only if it is a valid polygon that still retains most of the
 *    convex hull's area — `ST_ConcaveHull` on sparse or awkward point sets can
 *    return a spidery sliver that technically contains the samples but describes
 *    no plausible plot.
 * 2. **Convex hull**, the honest default: the smallest polygon containing the walk.
 * 3. **Buffered convex hull**, for point sets that cannot form a polygon at all —
 *    one point, two points, a perfectly straight line of readings.
 *
 * The winner is then grown by `HULL_BUFFER_M` in *geography* space, so the buffer
 * is metres rather than degrees, and the result is forced back to a single POLYGON
 * to match the column type.
 */
function hullCteSql(pointsExpr: string): string {
  return `
    WITH pts AS (
      SELECT ${pointsExpr} AS g
    ),
    cand AS (
      SELECT g,
             ST_ConvexHull(g) AS cx,
             CASE WHEN ST_NPoints(g) >= ${CONCAVE_HULL_MIN_POINTS}
                  THEN ST_ConcaveHull(g, ${CONCAVE_HULL_TARGET})
             END AS cc
        FROM pts
    ),
    picked AS (
      SELECT g,
             CASE
               WHEN cc IS NOT NULL
                    AND GeometryType(cc) = 'POLYGON'
                    AND ST_IsValid(cc)
                    AND ST_Area(cc::geography)
                        >= ${HULL_MIN_AREA_RATIO} * NULLIF(ST_Area(cx::geography), 0)
                 THEN cc
               WHEN GeometryType(cx) = 'POLYGON' AND ST_IsValid(cx)
                 THEN cx
               ELSE ST_ConvexHull(ST_Buffer(g::geography, ${DEGENERATE_BUFFER_M})::geometry)
             END AS h
        FROM cand
    ),
    grown AS (
      SELECT ST_Buffer(h::geography, ${HULL_BUFFER_M})::geometry AS b FROM picked
    ),
    hull AS (
      SELECT CASE
               WHEN GeometryType(b) = 'POLYGON' THEN b
               ELSE ST_ConvexHull(b)
             END AS boundary
        FROM grown
    )
  `;
}

/**
 * Hectares from a boundary, clamped positive. The clamp can only bite if PostGIS
 * returns a degenerate area for a buffered polygon, which should be impossible —
 * but `area_ha > 0` is a CHECK, and a failed constraint would abort the whole
 * sync transaction over a rounding artefact.
 */
const AREA_HA_EXPR = (boundary: string) =>
  `GREATEST(ROUND((ST_Area(${boundary}::geography) / 10000.0)::numeric, 4), 0.0001)`;

/** A field that a cluster might belong to, with the two facts that decide it. */
export interface FieldMatch {
  id: string;
  name: string | null;
  source: string;
  /** Metres from the field's geometry to the nearest point of the cluster. */
  distance_m: number;
  /** True when the stored boundary actually contains or crosses the cluster. */
  overlaps: boolean;
}

/**
 * The existing field this cluster most likely belongs to, or null for new ground.
 *
 * Overlap wins over proximity: a cluster whose points fall inside a stored
 * boundary belongs to that field even if a neighbouring field's centroid happens
 * to be closer. Distance is measured to the *nearest point of the cluster* rather
 * than between centroids, because a farmer re-walking the far half of a large plot
 * produces a cluster whose centroid is a long way from the stored one while still
 * plainly being the same field.
 *
 * Fields with no geometry at all (created by hand before GPS existed) are skipped
 * — there is nothing to compare against, and guessing would attach a walk to an
 * arbitrary field.
 */
export async function findMatchingField(
  farmerId: string,
  clusterWkt: string,
  radiusMeters: number,
  db: Queryable = getPool(),
): Promise<FieldMatch | null> {
  const { rows } = await db.query<FieldMatch>(
    `WITH cluster AS (SELECT ST_GeomFromText($2::text, 4326) AS g)
     SELECT f.id,
            f.name,
            f.source,
            ST_Distance(
              COALESCE(f.boundary, f.centroid)::geography,
              cluster.g::geography
            ) AS distance_m,
            COALESCE(
              f.boundary IS NOT NULL AND ST_Intersects(f.boundary, cluster.g),
              false
            ) AS overlaps
       FROM fields f, cluster
      WHERE f.farmer_id = $1
        AND (f.boundary IS NOT NULL OR f.centroid IS NOT NULL)
        AND ST_DWithin(
              COALESCE(f.boundary, f.centroid)::geography,
              cluster.g::geography,
              $3::double precision
            )
      ORDER BY "overlaps" DESC, distance_m ASC
      LIMIT 1`,
    [farmerId, clusterWkt, radiusMeters],
  );
  return rows[0] ?? null;
}

/**
 * Create a field from a cluster of points: hull, centroid, area, provenance.
 *
 * `name` is deliberately null. The label a farmer sees ("Field 2" / "खेत 2") is a
 * UI concern in a bilingual app — writing an English name into the database at
 * detection time would leak a language choice into storage and then show it,
 * untranslated, to a Hindi-first user. `detected_at` plus creation order give the
 * client everything it needs to number them.
 *
 * `region_code` is inherited from the farmer rather than defaulted, since it keys
 * the agronomy config every recommendation for this field will use.
 */
export async function insertAutoField(
  farmerId: string,
  clusterWkt: string,
  db: Queryable = getPool(),
): Promise<FieldRow> {
  const { rows } = await db.query<{ id: string }>(
    `${hullCteSql('ST_GeomFromText($2::text, 4326)')}
     INSERT INTO fields (
       farmer_id, name, boundary, centroid, area_ha, region_code, source, detected_at
     )
     SELECT $1,
            NULL,
            hull.boundary,
            ST_Centroid(hull.boundary),
            ${AREA_HA_EXPR('hull.boundary')},
            COALESCE((SELECT region_code FROM farmers WHERE id = $1), 'chambal'),
            'auto',
            now()
       FROM hull
      WHERE hull.boundary IS NOT NULL
     RETURNING id`,
    [farmerId, clusterWkt],
  );
  if (!rows[0]) throw new Error('segregation: hull produced no boundary for cluster');

  const field = await findFieldRow(rows[0].id, db);
  if (!field) throw new Error('segregation: created field could not be read back');
  return field;
}

/**
 * Re-derive an auto field's boundary from every reading assigned to it.
 *
 * Called after new points land in an existing field: the plot did not change, but
 * what is known about its extent did, and a boundary that never grows would keep
 * rejecting the edges of later walks. Manual fields are filtered out in the WHERE
 * clause rather than by the caller, so there is no code path that can overwrite a
 * hand-drawn boundary by mistake.
 *
 * Returns false when nothing was updated — no readings with GPS, or the field is
 * manual. Both are normal, neither is an error.
 */
export async function recomputeAutoFieldGeometry(
  fieldId: string,
  db: Queryable = getPool(),
): Promise<boolean> {
  const result = await db.query(
    `${hullCteSql(
      '(SELECT ST_Collect(location) FROM readings WHERE field_id = $1 AND location IS NOT NULL)',
    )}
     UPDATE fields f
        SET boundary = hull.boundary,
            centroid = ST_Centroid(hull.boundary),
            area_ha  = ${AREA_HA_EXPR('hull.boundary')}
       FROM hull
      WHERE f.id = $1
        AND f.source = 'auto'
        AND hull.boundary IS NOT NULL`,
    [fieldId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Recompute and store the field's mean of every metric across every reading it
 * holds — the "aggregate latest reading" the dashboard shows.
 *
 * Recomputed from scratch rather than updated incrementally. A running mean would
 * be cheaper, but it drifts: it cannot survive a reading being reassigned to
 * another field, deleted, or double-counted by a retried sync, and a silently
 * wrong average is worse than a slightly slower one. At field scale this is an
 * indexed scan over tens of rows.
 *
 * `COUNT(*)` over an empty set still returns one row (0), so a field whose
 * readings all went away gets a zeroed aggregate rather than a stale one.
 */
export async function refreshFieldAggregates(
  fieldId: string,
  db: Queryable = getPool(),
): Promise<number> {
  const { rows } = await db.query<{ reading_count: number }>(
    `INSERT INTO field_aggregates (
       field_id, reading_count,
       n_mgkg, p_mgkg, k_mgkg, ph, ec_uscm, moisture_vwc, soil_temp_c,
       first_reading_at, last_reading_at, updated_at
     )
     SELECT $1,
            COUNT(*)::int,
            ROUND(AVG(n_mgkg), 2),
            ROUND(AVG(p_mgkg), 2),
            ROUND(AVG(k_mgkg), 2),
            ROUND(AVG(ph), 2),
            ROUND(AVG(ec_uscm), 1),
            ROUND(AVG(moisture_vwc), 2),
            ROUND(AVG(soil_temp_c), 2),
            MIN(taken_at),
            MAX(taken_at),
            now()
       FROM readings
      WHERE field_id = $1
     ON CONFLICT (field_id) DO UPDATE SET
       reading_count    = EXCLUDED.reading_count,
       n_mgkg           = EXCLUDED.n_mgkg,
       p_mgkg           = EXCLUDED.p_mgkg,
       k_mgkg           = EXCLUDED.k_mgkg,
       ph               = EXCLUDED.ph,
       ec_uscm          = EXCLUDED.ec_uscm,
       moisture_vwc     = EXCLUDED.moisture_vwc,
       soil_temp_c      = EXCLUDED.soil_temp_c,
       first_reading_at = EXCLUDED.first_reading_at,
       last_reading_at  = EXCLUDED.last_reading_at,
       updated_at       = now()
     RETURNING reading_count`,
    [fieldId],
  );
  return rows[0]?.reading_count ?? 0;
}

/**
 * Adopt this farmer's previously unassigned readings that fall inside the field's
 * new boundary.
 *
 * A lone reading on the edge of a plot is noise on the sync that carried it, and
 * gets stored with no field. Once a later walk establishes the field, that orphan
 * is inside a known boundary and belongs to it.
 *
 * Ownership is enforced through the device: `readings` has no farmer column, so
 * the only trustworthy link from an unassigned reading back to a person is
 * `devices.owner_farmer_id`. Orphans with no device are left alone — attaching
 * them on geometry alone would let one farmer's field absorb another's readings if
 * their plots happen to overlap.
 */
export async function attachOrphanReadingsWithin(
  fieldId: string,
  farmerId: string,
  db: Queryable = getPool(),
): Promise<number> {
  const result = await db.query(
    `UPDATE readings r
        SET field_id = $1
      WHERE r.field_id IS NULL
        AND r.location IS NOT NULL
        AND r.device_id IN (SELECT d.id FROM devices d WHERE d.owner_farmer_id = $2)
        AND EXISTS (
              SELECT 1 FROM fields f
               WHERE f.id = $1
                 AND f.boundary IS NOT NULL
                 AND ST_Contains(f.boundary, r.location)
            )`,
    [fieldId, farmerId],
  );
  return result.rowCount ?? 0;
}

/**
 * Read a field back through the shared column list, so a row produced here is
 * indistinguishable from one the fields module produced.
 */
export async function findFieldRow(
  fieldId: string,
  db: Queryable = getPool(),
): Promise<FieldRow | null> {
  const { rows } = await db.query<FieldRow>(
    `SELECT ${FIELD_SELECT_COLS} FROM ${FIELD_SELECT_FROM} WHERE f.id = $1`,
    [fieldId],
  );
  return rows[0] ?? null;
}

/**
 * Sessions already recorded against a field, newest walk first. Lets the sync
 * response tell the app "these eight readings joined the field you walked on
 * Tuesday" instead of just handing back an id.
 */
export async function listFieldSessions(
  fieldId: string,
  db: Queryable = getPool(),
): Promise<{ session_id: string; reading_count: number; last_reading_at: Date }[]> {
  const { rows } = await db.query<{
    session_id: string;
    reading_count: number;
    last_reading_at: Date;
  }>(
    `SELECT session_id, COUNT(*)::int AS reading_count, MAX(taken_at) AS last_reading_at
       FROM readings
      WHERE field_id = $1 AND session_id IS NOT NULL
      GROUP BY session_id
      ORDER BY MAX(taken_at) DESC`,
    [fieldId],
  );
  return rows;
}
