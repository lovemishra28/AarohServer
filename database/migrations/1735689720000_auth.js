/**
 * Phase 2 — authentication support tables (SERVER_DEVELOPMENT_GUIDE §6.1).
 *
 * Farmers log in with phone + one-time code; agents/admins add a password. Both
 * flows need short-lived OTP challenges and revocable refresh tokens. Access
 * tokens themselves are stateless JWTs (signed with node:crypto HS256, no
 * library — the sandbox/CI has no network to add one) so they are NOT stored;
 * only refresh tokens are persisted so a session can be revoked.
 *
 *  - otp_challenges : issued one-time codes, with expiry + attempt counter. In
 *                     development the code is generated locally and logged /
 *                     returned (no SMS provider), so `code` is stored in the
 *                     clear on purpose — a production SMS integration would store
 *                     a hash instead.
 *  - refresh_tokens : one row per issued refresh token, stored as a SHA-256 hash
 *                     (never the raw token), so it can be looked up and revoked.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // ── otp_challenges ────────────────────────────────────────────────────────
  pgm.createTable('otp_challenges', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    phone: { type: 'text', notNull: true },
    // Dev stub: plaintext code, no SMS. Production: store a hash instead.
    code: { type: 'text', notNull: true },
    purpose: {
      type: 'text',
      notNull: true,
      default: 'login',
      check: "purpose IN ('login')",
    },
    expires_at: { type: 'timestamptz', notNull: true },
    consumed_at: { type: 'timestamptz' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Rate limiting and "most recent unconsumed challenge" both query by phone,
  // newest first.
  pgm.createIndex('otp_challenges', ['phone', 'created_at'], {
    name: 'otp_challenges_phone_created_at',
  });

  // ── refresh_tokens ──────────────────────────────────────────────────────
  pgm.createTable('refresh_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    farmer_id: {
      type: 'uuid',
      notNull: true,
      references: 'farmers',
      onDelete: 'CASCADE',
    },
    // SHA-256 of the raw refresh token — never the token itself.
    token_hash: { type: 'text', notNull: true, unique: true },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('refresh_tokens', 'farmer_id');
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('refresh_tokens');
  pgm.dropTable('otp_challenges');
};
