/**
 * Phase 3 — multi-provider authentication (README §5 "Authentication providers").
 *
 * The v1 schema assumed one way in: phone + OTP. `farmers.phone` was
 * `NOT NULL UNIQUE`, which makes an email-only or Google-only account
 * *unrepresentable*. The client now offers three doors — phone+OTP,
 * email+password, and "Continue with Google" — so identity has to become a set
 * of optional, individually-unique identifiers instead of a single mandatory one.
 *
 * farmers gains:
 *  - phone            : NOT NULL dropped (still unique; PostgreSQL lets a unique
 *                       column hold many NULLs, so absent phones don't collide).
 *  - email            : unique **case-insensitively** via a UNIQUE INDEX on
 *                       lower(email). Storing the address as typed keeps it
 *                       displayable, while the functional index stops
 *                       Ram@x.com and ram@x.com from becoming two accounts.
 *  - google_sub       : Google's stable subject claim ("sub"). This — not the
 *                       email — is the durable Google identity: a Google account
 *                       can change its email address, but never its sub.
 *  - email_verified_at: set when an email OTP is confirmed (or trusted straight
 *                       from Google's `email_verified` claim).
 *
 * A CHECK enforces that every row still has at least one way to be found, so
 * relaxing phone can't silently create orphan identity rows.
 *
 * otp_challenges becomes channel-agnostic: exactly one of phone/email is set
 * (XOR), and `purpose` widens past 'login' to cover email verification and
 * password reset, which reuse the same expiry + attempt-counter machinery.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // ── farmers: optional, individually-unique identifiers ────────────────────
  pgm.alterColumn('farmers', 'phone', { notNull: false });

  pgm.addColumns('farmers', {
    email: { type: 'text' },
    google_sub: { type: 'text' },
    email_verified_at: { type: 'timestamptz' },
  });

  // Functional unique index — `pgm.addConstraint` cannot express lower(email).
  pgm.sql('CREATE UNIQUE INDEX farmers_email_lower_key ON farmers (lower(email))');

  pgm.addConstraint('farmers', 'farmers_google_sub_key', { unique: 'google_sub' });

  // Every farmer must remain reachable by at least one identifier.
  pgm.addConstraint('farmers', 'farmers_identity_present', {
    check: 'phone IS NOT NULL OR email IS NOT NULL OR google_sub IS NOT NULL',
  });

  // ── otp_challenges: phone OR email, and more purposes ─────────────────────
  pgm.alterColumn('otp_challenges', 'phone', { notNull: false });
  pgm.addColumns('otp_challenges', {
    email: { type: 'text' },
  });

  // Replace the inline CHECK created with the column in the Phase-2 migration.
  // DROP ... IF EXISTS because the auto-generated constraint name is an
  // implementation detail of node-pg-migrate, not something to depend on.
  pgm.sql('ALTER TABLE otp_challenges DROP CONSTRAINT IF EXISTS otp_challenges_purpose_check');
  pgm.addConstraint('otp_challenges', 'otp_challenges_purpose_check', {
    check: "purpose IN ('login', 'email_verify', 'password_reset')",
  });

  // Exactly one delivery target per challenge (XOR): a code is either texted or
  // emailed, never both, and never neither.
  pgm.addConstraint('otp_challenges', 'otp_challenges_one_target', {
    check: '(phone IS NOT NULL) <> (email IS NOT NULL)',
  });

  // Mirrors otp_challenges_phone_created_at: rate limiting and "newest
  // challenge for this address" both scan by target, newest first.
  pgm.sql(
    'CREATE INDEX otp_challenges_email_created_at ON otp_challenges (lower(email), created_at)',
  );
};

/**
 * Reverse order. Note the down migration will fail loudly (NOT NULL violation)
 * if email-only or Google-only farmers already exist — that is correct: it means
 * data would be lost, and the operator should decide what to do with those rows
 * rather than have a migration silently discard them.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS otp_challenges_email_created_at');
  pgm.dropConstraint('otp_challenges', 'otp_challenges_one_target');
  pgm.dropConstraint('otp_challenges', 'otp_challenges_purpose_check');
  pgm.addConstraint('otp_challenges', 'otp_challenges_purpose_check', {
    check: "purpose IN ('login')",
  });
  pgm.dropColumns('otp_challenges', ['email']);
  pgm.sql('DELETE FROM otp_challenges WHERE phone IS NULL');
  pgm.alterColumn('otp_challenges', 'phone', { notNull: true });

  pgm.dropConstraint('farmers', 'farmers_identity_present');
  pgm.dropConstraint('farmers', 'farmers_google_sub_key');
  pgm.sql('DROP INDEX IF EXISTS farmers_email_lower_key');
  pgm.dropColumns('farmers', ['email', 'google_sub', 'email_verified_at']);
  pgm.alterColumn('farmers', 'phone', { notNull: true });
};
