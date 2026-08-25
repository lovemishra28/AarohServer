/**
 * Phase 0 baseline migration.
 *
 * Enables the PostGIS extension. No tables yet — the full v1 schema
 * (farmers, fields, devices, readings, recommendations, ...) arrives in
 * Phase 2 (see SERVER_DEVELOPMENT_GUIDE.md §5.2).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createExtension('postgis', { ifNotExists: true });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropExtension('postgis', { ifExists: true });
};
