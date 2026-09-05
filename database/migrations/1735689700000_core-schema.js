/**
 * Phase 2 — core v1 schema (SERVER_DEVELOPMENT_GUIDE.md §5.2, §5.4).
 *
 * Tables: farmers, devices, fields, readings, recommendations,
 * model_registry, feedback. PostGIS is already enabled by the Phase-0
 * baseline migration, so geometry columns and GiST indexes are available here.
 *
 * Two conventions this schema enforces at the storage layer, on purpose:
 *
 *  1. **Unit-suffixed nutrient columns.** The probe reports *elemental* N/P/K in
 *     mg/kg, so those columns are `n_mgkg` / `p_mgkg` / `k_mgkg`. There is no bare
 *     `p`. The oxide basis (P2O5 / K2O) only ever appears downstream inside the
 *     recommendation `result` JSON, never as a raw reading. This kills the
 *     "oxide trap" (ADR-0004) at the column level.
 *  2. **CHECK constraints on physically-bounded inputs.** `ph` must be 3–10 and
 *     `ec_uscm` must be ≥ 0 when present (§5.4), so a garbage reading is rejected
 *     by the database, not just by application code.
 *
 * `gen_random_uuid()` is a core function in PostgreSQL 13+, so no extension is
 * needed for UUID primary keys on PG16.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql('SET search_path TO "$user", public, extensions;');

  // ── farmers ────────────────────────────────────────────────────────────────
  // The identity table. Farmers authenticate by phone + OTP; agents/admins also
  // carry a password_hash (§6.1). `role` gates RBAC.
  pgm.createTable('farmers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    phone: { type: 'text', notNull: true, unique: true },
    name: { type: 'text' },
    preferred_lang: {
      type: 'text',
      notNull: true,
      default: 'hi',
      check: "preferred_lang IN ('hi', 'en')",
    },
    region_code: { type: 'text', notNull: true, default: 'chambal' },
    role: {
      type: 'text',
      notNull: true,
      default: 'farmer',
      check: "role IN ('farmer', 'agent', 'admin')",
    },
    // Null for phone-only farmers; set for agents/admins (§6.1).
    password_hash: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // ── devices ──────────────────────────────────────────────────────────────
  // Physical probes. `calibration_profile_id` is a forward-looking nullable
  // pointer: per-device NPK calibration does not exist yet (the probe reports an
  // uncalibrated proxy), so there is no calibration_profiles table to FK to.
  pgm.createTable('devices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    serial: { type: 'text', notNull: true, unique: true },
    firmware_version: { type: 'text' },
    owner_farmer_id: {
      type: 'uuid',
      references: 'farmers',
      onDelete: 'SET NULL',
    },
    calibration_profile_id: { type: 'uuid' },
    last_seen_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // ── fields ─────────────────────────────────────────────────────────────────
  // A farmer's plot. `boundary`/`centroid` are PostGIS geometry in WGS84 (4326),
  // nullable until the GPS gap is closed (firmware currently writes GPS:PENDING).
  // `area_ha`, when present, must be positive.
  pgm.createTable('fields', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    farmer_id: {
      type: 'uuid',
      notNull: true,
      references: 'farmers',
      onDelete: 'CASCADE',
    },
    name: { type: 'text' },
    boundary: { type: 'geometry(Polygon,4326)' },
    centroid: { type: 'geometry(Point,4326)' },
    area_ha: { type: 'numeric', check: 'area_ha IS NULL OR area_ha > 0' },
    region_code: { type: 'text', notNull: true, default: 'chambal' },
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
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // GiST indexes for spatial queries (field clustering, containment).
  pgm.createIndex('fields', 'boundary', { method: 'gist', name: 'fields_boundary_gist' });
  pgm.createIndex('fields', 'centroid', { method: 'gist', name: 'fields_centroid_gist' });
  pgm.createIndex('fields', 'farmer_id');

  // ── readings ─────────────────────────────────────────────────────────────
  // One soil measurement. NPK are **elemental mg/kg** (unit-suffixed columns).
  // `idempotency_key` is UNIQUE but nullable — batch ingest is idempotent (§6.1),
  // and Postgres treats NULLs as distinct so non-idempotent manual entries are
  // still allowed. `source` records provenance.
  pgm.createTable('readings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    device_id: { type: 'uuid', references: 'devices', onDelete: 'SET NULL' },
    field_id: { type: 'uuid', references: 'fields', onDelete: 'SET NULL' },
    taken_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    location: { type: 'geometry(Point,4326)' },
    // Elemental, mg/kg — the probe's native basis. NOT oxide. See file header.
    n_mgkg: { type: 'numeric', comment: 'Elemental nitrogen, mg/kg (probe proxy).' },
    p_mgkg: { type: 'numeric', comment: 'Elemental phosphorus, mg/kg (probe proxy) — NOT P2O5.' },
    k_mgkg: { type: 'numeric', comment: 'Elemental potassium, mg/kg (probe proxy) — NOT K2O.' },
    ph: { type: 'numeric', check: 'ph IS NULL OR (ph BETWEEN 3 AND 10)' },
    ec_uscm: { type: 'numeric', check: 'ec_uscm IS NULL OR ec_uscm >= 0' },
    moisture_vwc: { type: 'numeric', comment: 'Volumetric water content, %.' },
    soil_temp_c: { type: 'numeric', comment: 'Root-zone soil temperature, °C.' },
    npk_is_calibrated: { type: 'boolean', notNull: true, default: false },
    source: {
      type: 'text',
      notNull: true,
      check: "source IN ('probe_ble', 'manual', 'import')",
    },
    idempotency_key: { type: 'text', unique: true },
    raw_frame: { type: 'text', comment: 'Original device frame/CSV line, kept for audit.' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // "Latest reading for a field" is a hot query (GET /fields/:id, money path).
  pgm.createIndex('readings', ['field_id', 'taken_at'], { name: 'readings_field_taken_at' });
  pgm.createIndex('readings', 'device_id');

  // ── model_registry ──────────────────────────────────────────────────────
  // Mirror of the AI service's file-based registry (ADR-0003) so the API can
  // answer "which model produced this?" without calling Python. `version` is the
  // natural PK (e.g. 'crop-ranker@1.0.0').
  pgm.createTable('model_registry', {
    version: { type: 'text', primaryKey: true },
    algo: { type: 'text' },
    trained_at: { type: 'timestamptz' },
    dataset_hash: { type: 'text' },
    metrics: { type: 'jsonb' },
    artifact_uri: { type: 'text' },
    feature_spec_uri: { type: 'text' },
    is_active: { type: 'boolean', notNull: true, default: false },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // ── recommendations ─────────────────────────────────────────────────────
  // A persisted RecommendationResult (§6.4). The full result is stored as JSONB
  // exactly as the AI service returned it; the scalar columns are denormalised
  // for querying and provenance. `model_version` + `agronomy_version` pin which
  // engines produced it, so a later re-tune never silently rewrites history.
  pgm.createTable('recommendations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    field_id: {
      type: 'uuid',
      notNull: true,
      references: 'fields',
      onDelete: 'CASCADE',
    },
    reading_id: { type: 'uuid', references: 'readings', onDelete: 'SET NULL' },
    model_version: { type: 'text', notNull: true },
    agronomy_version: { type: 'text', notNull: true },
    region_code: { type: 'text', notNull: true },
    area_ha: { type: 'numeric', notNull: true, check: 'area_ha > 0' },
    result: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('recommendations', ['field_id', 'created_at'], {
    name: 'recommendations_field_created_at',
  });

  // ── feedback ─────────────────────────────────────────────────────────────
  // Ground-truth loop: what the farmer actually planted and how it turned out,
  // plus an optional lab test to eventually calibrate the probe proxy.
  pgm.createTable('feedback', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    recommendation_id: {
      type: 'uuid',
      notNull: true,
      references: 'recommendations',
      onDelete: 'CASCADE',
    },
    farmer_id: {
      type: 'uuid',
      notNull: true,
      references: 'farmers',
      onDelete: 'CASCADE',
    },
    chosen_crop: { type: 'text' },
    actually_planted: { type: 'text' },
    outcome: { type: 'text' },
    lab_test: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('feedback', 'recommendation_id');
};

/**
 * Drop in reverse dependency order.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('feedback');
  pgm.dropTable('recommendations');
  pgm.dropTable('model_registry');
  pgm.dropTable('readings');
  pgm.dropTable('fields');
  pgm.dropTable('devices');
  pgm.dropTable('farmers');
};
