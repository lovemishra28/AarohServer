/**
 * Phase 2 — versioned region-configuration tables (SERVER_DEVELOPMENT_GUIDE §5.4).
 *
 * The deterministic agronomy engine's inputs are region- and version-scoped so a
 * future STCR-calibrated table drops in beside the provisional one without a
 * code change, and every recommendation records exactly which version it used.
 * These three tables are the Postgres mirror of the AI service's canonical JSON
 * (`services/agronomy/regions/chambal/2026.08-provisional.json`) — that file
 * stays the single source of truth; the seed script (`database/seeds`) derives
 * these rows from it, so the two never drift.
 *
 *  - region_config : scalar/region-level config — bag size, rounding, the
 *                    Low/Medium/High class multipliers, elemental soil-test
 *                    thresholds, and unit factors. One row per (region, version).
 *  - crop_band     : per-crop recommended dose (RDF) in oxide kg/ha + Hindi name
 *                    + legume flag. One row per (region, version, crop).
 *  - price_table   : fertiliser products, their N-P2O5-K2O grades and ₹/bag.
 *                    One row per (region, version, product).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // ── region_config ─────────────────────────────────────────────────────────
  pgm.createTable('region_config', {
    region_code: { type: 'text', notNull: true },
    version: { type: 'text', notNull: true },
    // The string stamped onto every recommendation, e.g.
    // 'chambal-stcr@2026.08-provisional'.
    agronomy_version: { type: 'text', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: false },
    provisional: { type: 'boolean', notNull: true, default: true },
    bag_kg: { type: 'numeric', notNull: true },
    rounding: {
      type: 'text',
      notNull: true,
      check: "rounding IN ('nearest', 'up')",
    },
    // dose(crop, nutrient) = rdf × multiplier[soil_class of that nutrient].
    mult_low: { type: 'numeric', notNull: true },
    mult_medium: { type: 'numeric', notNull: true },
    mult_high: { type: 'numeric', notNull: true },
    // Elemental kg/ha soil-test thresholds: value < low_max ⇒ Low, < med_max ⇒
    // Medium, else High. NOT oxide (Olsen-P is elemental) — see ADR-0004.
    n_low_max: { type: 'numeric', notNull: true },
    n_med_max: { type: 'numeric', notNull: true },
    p_low_max: { type: 'numeric', notNull: true },
    p_med_max: { type: 'numeric', notNull: true },
    k_low_max: { type: 'numeric', notNull: true },
    k_med_max: { type: 'numeric', notNull: true },
    // Unit factors. mgkg_to_kgha is on the v1 number path; the oxide factors are
    // stored for the future STCR equation but are deliberately unused in v1.
    mgkg_to_kgha: { type: 'numeric', notNull: true },
    p_to_p2o5: { type: 'numeric', notNull: true },
    k_to_k2o: { type: 'numeric', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('region_config', 'region_config_pkey', {
    primaryKey: ['region_code', 'version'],
  });
  // At most one active config per region. A partial unique index is the correct
  // way to express "one row where is_active" without forbidding many inactive
  // versions to coexist.
  pgm.createIndex('region_config', 'region_code', {
    name: 'region_config_one_active',
    unique: true,
    where: 'is_active',
  });

  // ── crop_band ─────────────────────────────────────────────────────────────
  pgm.createTable('crop_band', {
    region_code: { type: 'text', notNull: true },
    version: { type: 'text', notNull: true },
    crop: { type: 'text', notNull: true },
    crop_hi: { type: 'text', notNull: true },
    // Recommended dose of fertiliser (RDF), stated in OXIDE kg/ha to match how
    // products are graded — so the dose→product step needs no conversion.
    rdf_n_kgha: { type: 'numeric', notNull: true },
    rdf_p2o5_kgha: { type: 'numeric', notNull: true },
    rdf_k2o_kgha: { type: 'numeric', notNull: true },
    is_legume: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('crop_band', 'crop_band_pkey', {
    primaryKey: ['region_code', 'version', 'crop'],
  });
  pgm.addConstraint('crop_band', 'crop_band_region_config_fk', {
    foreignKeys: {
      columns: ['region_code', 'version'],
      references: 'region_config (region_code, version)',
      onDelete: 'CASCADE',
    },
  });

  // ── price_table ────────────────────────────────────────────────────────────
  pgm.createTable('price_table', {
    region_code: { type: 'text', notNull: true },
    version: { type: 'text', notNull: true },
    product: { type: 'text', notNull: true },
    n_pct: { type: 'numeric', notNull: true },
    p2o5_pct: { type: 'numeric', notNull: true },
    k2o_pct: { type: 'numeric', notNull: true },
    inr_per_bag: { type: 'numeric', notNull: true },
    // Which nutrients this product is allowed to supply, e.g. ["P2O5","N"].
    supplies: { type: 'jsonb', notNull: true },
  });
  pgm.addConstraint('price_table', 'price_table_pkey', {
    primaryKey: ['region_code', 'version', 'product'],
  });
  pgm.addConstraint('price_table', 'price_table_region_config_fk', {
    foreignKeys: {
      columns: ['region_code', 'version'],
      references: 'region_config (region_code, version)',
      onDelete: 'CASCADE',
    },
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('price_table');
  pgm.dropTable('crop_band');
  pgm.dropTable('region_config');
};
