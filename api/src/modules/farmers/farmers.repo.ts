import { getPool, type Queryable } from '../../common/db';

/** A row of the `farmers` table. `password_hash` is never exposed to clients. */
export interface FarmerRow {
  id: string;
  phone: string;
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
  phone: string;
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
    name: row.name,
    preferred_lang: row.preferred_lang,
    region_code: row.region_code,
    role: row.role,
    created_at: row.created_at.toISOString(),
  };
}

export async function findFarmerById(id: string, db: Queryable = getPool()): Promise<FarmerRow | null> {
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
