/**
 * Phase 3 — automated field segregation (Workstream 2).
 *
 * Until now a reading only reached the database if the app already knew which
 * field it belonged to: the farmer drew the field by hand first, then measured
 * inside it. The stick inverts that. It emits a GPS point per measurement and
 * nothing else, so the *field* is a conclusion drawn from a cloud of points, not
 * an input. Three things have to exist before that conclusion can be stored.
 *
 * 1. **`readings.session_id`** — the stick's `SID`, one walk of one field. It is
 *    free text, not a UUID: the value comes from firmware (`A-0829`), and forcing
 *    it into a UUID column would mean either rejecting real frames or inventing an
 *    id and throwing away the one the device actually sent. Clustering groups by
 *    geometry, never by this, but it is what lets a field's history read as "eight
 *    points, one walk, 29 Aug" instead of eight unrelated rows.
 *
 * 2. **A GiST index on `readings.location`.** The core schema created the geometry
 *    column but only indexed `(field_id, taken_at)`. Every query added by this
 *    workstream is spatial — "which readings are near this cluster", "which field
 *    contains this point" — and without the index they are sequential scans.
 *
 * 3. **Provenance on `fields`.** A field the system inferred and a field the
 *    farmer drew must be distinguishable, because they have different rules: an
 *    auto-detected boundary is re-derived from its readings on every sync, while a
 *    hand-entered boundary or area is never overwritten. Losing that distinction
 *    would mean a sync silently redrawing a boundary the farmer set deliberately.
 *
 * `field_aggregates` holds the per-field means (the "aggregate latest reading").
 * It is a separate table rather than columns on `fields` for two reasons: it is
 * derived data with its own freshness (`updated_at`, `reading_count`) that must be
 * recomputable from scratch, and `fields` stays what it is — identity, geometry,
 * ownership. One row per field, so `ON CONFLICT (field_id) DO UPDATE` is the whole
 * refresh path.
 *
 * The mean columns carry no CHECK constraints on purpose. A mean is arithmetic on
 * values that were already validated on the way in; re-asserting bounds here would
 * turn a rounding artefact at the edge of a range into a failed sync.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // ── readings: which walk a point came from, and a usable spatial index ──────
  pgm.addColumns('readings', {
    session_id: {
      type: 'text',
      comment: "Device-supplied session id (frame key SID) — one walk of one field. Free text, not a UUID.",
    },
  });
  pgm.createIndex('readings', 'location', {
    method: 'gist',
    name: 'readings_location_gist',
    where: 'location IS NOT NULL',
  });
  // Segregation asks "which of this farmer's recent readings have GPS but no
  // field yet" on every sync; without this the answer is a full scan of readings.
  pgm.createIndex('readings', ['session_id', 'taken_at'], {
    name: 'readings_session_taken_at',
    where: 'session_id IS NOT NULL',
  });

  // ── fields: how this field came to exist ───────────────────────────────────
  pgm.addColumns('fields', {
    source: {
      type: 'text',
      notNull: true,
      default: 'manual',
      check: "source IN ('manual', 'auto')",
      comment: "'auto' fields were inferred from a GPS cluster and may be re-derived; 'manual' boundaries are never overwritten.",
    },
    detected_at: {
      type: 'timestamptz',
      comment: 'When segregation first inferred this field. Null for manually created fields.',
    },
  });

  // ── field_aggregates: the field's aggregate latest reading ─────────────────
  pgm.createTable('field_aggregates', {
    field_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'fields',
      onDelete: 'CASCADE',
    },
    reading_count: { type: 'integer', notNull: true, default: 0 },
    // Means across every reading assigned to the field. Elemental mg/kg for NPK —
    // the same basis as `readings`, never oxide (see the core-schema header).
    n_mgkg: { type: 'numeric' },
    p_mgkg: { type: 'numeric' },
    k_mgkg: { type: 'numeric' },
    ph: { type: 'numeric' },
    ec_uscm: { type: 'numeric' },
    moisture_vwc: { type: 'numeric' },
    soil_temp_c: { type: 'numeric' },
    first_reading_at: { type: 'timestamptz' },
    last_reading_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

/**
 * Drop in reverse order. `field_aggregates` is derived data — recomputed from
 * `readings` on the next sync — so dropping it loses nothing that cannot be
 * rebuilt. The `session_id` and `source` columns do hold information that only
 * existed at ingest time, which is why this down migration is a rollback of a
 * bad deploy, not a routine operation.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('field_aggregates');
  pgm.dropColumns('fields', ['source', 'detected_at']);
  pgm.dropIndex('readings', ['session_id', 'taken_at'], { name: 'readings_session_taken_at' });
  pgm.dropIndex('readings', 'location', { name: 'readings_location_gist' });
  pgm.dropColumns('readings', ['session_id']);
};
