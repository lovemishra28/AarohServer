import { getPool, type Queryable } from '../../common/db';

/**
 * Farmer identity storage.
 *
 * Since the Phase-3 `auth-providers` migration a farmer can be identified by any
 * combination of phone, email, and Google subject — all three columns are
 * nullable and individually unique, with a table CHECK guaranteeing at least one
 * is present. Every column here is therefore `| null` except `id`, `role`, and
 * the settings that carry defaults.
 */

/** A row of the `farmers` table. `password_hash` is never exposed to clients. */
export interface FarmerRow {
  id: string;
  phone: string | null;
  email: string | null;
  /** Google's `sub` claim — the stable Google identity, not the email. */
  google_sub: string | null;
  email_verified_at: Date | null;
  name: string | null;
  preferred_lang: string;
  region_code: string;
  role: string;
  password_hash: string | null;
  created_at: Date;
}

/** The farmer shape safe to return over the API (no secrets). */
export interface PublicFarmer {
  id: string;
  phone: string | null;
  email: string | null;
  /** Flattened from `email_verified_at` — clients only need the boolean. */
  email_verified: boolean;
  name: string | null;
  preferred_lang: string;
  region_code: string;
  role: string;
  created_at: string;
}

export function toPublicFarmer(row: FarmerRow): PublicFarmer {
  return {
    id: row.id,
    phone: row.phone,
    email: row.email,
    email_verified: row.email_verified_at !== null,
    name: row.name,
    preferred_lang: row.preferred_lang,
    region_code: row.region_code,
    role: row.role,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Normalise an email for lookup and storage: trimmed and lower-cased.
 *
 * The unique index is on `lower(email)`, so every read *and* write path has to
 * agree on this or two spellings of one address become two accounts. Doing it in
 * one exported function is what keeps that agreement.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findFarmerById(
  id: string,
  db: Queryable = getPool(),
): Promise<FarmerRow | null> {
  const { rows } = await db.query<FarmerRow>('SELECT * FROM farmers WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function findFarmerByPhone(
  phone: string,
  db: Queryable = getPool(),
): Promise<FarmerRow | null> {
  const { rows } = await db.query<FarmerRow>('SELECT * FROM farmers WHERE phone = $1', [phone]);
  return rows[0] ?? null;
}

/** Case-insensitive lookup, matching the `farmers_email_lower_key` index. */
export async function findFarmerByEmail(
  email: string,
  db: Queryable = getPool(),
): Promise<FarmerRow | null> {
  const { rows } = await db.query<FarmerRow>('SELECT * FROM farmers WHERE lower(email) = $1', [
    normalizeEmail(email),
  ]);
  return rows[0] ?? null;
}

export async function findFarmerByGoogleSub(
  googleSub: string,
  db: Queryable = getPool(),
): Promise<FarmerRow | null> {
  const { rows } = await db.query<FarmerRow>('SELECT * FROM farmers WHERE google_sub = $1', [
    googleSub,
  ]);
  return rows[0] ?? null;
}

/**
 * Get the farmer with this phone, creating one (role 'farmer') if none exists.
 * The no-op `DO UPDATE` lets a single statement both insert-or-find and RETURN
 * the row. An existing agent/admin keeps their elevated role on phone login.
 */
export async function upsertFarmerByPhone(
  phone: string,
  db: Queryable = getPool(),
): Promise<FarmerRow> {
  const { rows } = await db.query<FarmerRow>(
    `INSERT INTO farmers (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING *`,
    [phone],
  );
  return rows[0];
}

/**
 * Create an email farmer. Callers must have already hashed the password (see
 * `common/password.ts`) — a raw password never reaches this layer. `passwordHash`
 * is null for a passwordless account, i.e. one created by verifying an email
 * login code; such a farmer signs in by code (or Google) until they set a
 * password.
 *
 * Deliberately not an upsert: registering an address that already exists is a
 * user-facing conflict, not something to silently merge. The unique index raises
 * `23505` and the service turns that into EMAIL_TAKEN.
 */
export async function createEmailFarmer(
  input: { email: string; passwordHash: string | null; name: string | null; emailVerified?: boolean },
  db: Queryable = getPool(),
): Promise<FarmerRow> {
  const { rows } = await db.query<FarmerRow>(
    `INSERT INTO farmers (email, password_hash, name, email_verified_at)
     VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() ELSE NULL END)
     RETURNING *`,
    [normalizeEmail(input.email), input.passwordHash, input.name, input.emailVerified ?? false],
  );
  return rows[0];
}

/** Create a farmer straight from a verified Google identity (no password). */
export async function createGoogleFarmer(
  input: { googleSub: string; email: string | null; name: string | null; emailVerified: boolean },
  db: Queryable = getPool(),
): Promise<FarmerRow> {
  const { rows } = await db.query<FarmerRow>(
    `INSERT INTO farmers (google_sub, email, name, email_verified_at)
     VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() ELSE NULL END)
     RETURNING *`,
    [
      input.googleSub,
      input.email ? normalizeEmail(input.email) : null,
      input.name,
      input.emailVerified,
    ],
  );
  return rows[0];
}

/**
 * Attach a Google identity to an existing farmer — the account-linking step when
 * someone who registered with email+password later taps "Continue with Google"
 * with the same address. Without this they would end up with two accounts and
 * lose sight of their fields.
 *
 * `email_verified_at` is stamped opportunistically: Google has already proven
 * control of the address, so re-verifying it by emailing a code would be theatre.
 */
export async function linkGoogleSub(
  farmerId: string,
  input: { googleSub: string; emailVerified: boolean },
  db: Queryable = getPool(),
): Promise<FarmerRow> {
  const { rows } = await db.query<FarmerRow>(
    `UPDATE farmers
        SET google_sub = $2,
            email_verified_at = CASE
              WHEN $3::boolean AND email_verified_at IS NULL THEN now()
              ELSE email_verified_at
            END
      WHERE id = $1
      RETURNING *`,
    [farmerId, input.googleSub, input.emailVerified],
  );
  return rows[0];
}

/** Fill in a name we learned later (Google profile) without overwriting one the farmer set. */
export async function backfillFarmerName(
  farmerId: string,
  name: string,
  db: Queryable = getPool(),
): Promise<FarmerRow> {
  const { rows } = await db.query<FarmerRow>(
    `UPDATE farmers SET name = COALESCE(name, $2) WHERE id = $1 RETURNING *`,
    [farmerId, name],
  );
  return rows[0];
}

/**
 * PATCH /v1/me. Every field is optional; `COALESCE` leaves untouched fields
 * alone, so a partial patch stays partial instead of nulling the rest.
 */
export async function updateFarmerProfile(
  farmerId: string,
  patch: { name?: string; preferred_lang?: string; region_code?: string },
  db: Queryable = getPool(),
): Promise<FarmerRow | null> {
  const { rows } = await db.query<FarmerRow>(
    `UPDATE farmers
        SET name = COALESCE($2, name),
            preferred_lang = COALESCE($3, preferred_lang),
            region_code = COALESCE($4, region_code)
      WHERE id = $1
      RETURNING *`,
    [farmerId, patch.name ?? null, patch.preferred_lang ?? null, patch.region_code ?? null],
  );
  return rows[0] ?? null;
}

/** Replace a password hash (password reset, or transparent re-hash after a cost bump). */
export async function setPasswordHash(
  farmerId: string,
  passwordHash: string,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query('UPDATE farmers SET password_hash = $2 WHERE id = $1', [farmerId, passwordHash]);
}

/** Stamp the email as verified (idempotent — an already-verified time is kept). */
export async function markEmailVerified(
  farmerId: string,
  db: Queryable = getPool(),
): Promise<FarmerRow> {
  const { rows } = await db.query<FarmerRow>(
    `UPDATE farmers
        SET email_verified_at = COALESCE(email_verified_at, now())
      WHERE id = $1
      RETURNING *`,
    [farmerId],
  );
  return rows[0];
}

/** PostgreSQL unique-violation SQLSTATE — how a duplicate email/google_sub surfaces. */
export const UNIQUE_VIOLATION = '23505';

/** True when a thrown pg error is a unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}
