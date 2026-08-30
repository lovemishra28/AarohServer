import { getPool, type Queryable } from '../../common/db';
import type { PairDeviceBody } from './devices.dto';

export interface DeviceRow {
  id: string;
  serial: string;
  firmware_version: string | null;
  owner_farmer_id: string | null;
  calibration_profile_id: string | null;
  last_seen_at: Date | null;
  created_at: Date;
}

export interface PublicDevice {
  id: string;
  serial: string;
  firmware_version: string | null;
  owner_farmer_id: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export function toPublicDevice(row: DeviceRow): PublicDevice {
  return {
    id: row.id,
    serial: row.serial,
    firmware_version: row.firmware_version,
    owner_farmer_id: row.owner_farmer_id,
    last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Pair (claim) a device to a farmer. Idempotent and re-claimable: pairing the
 * same serial again just updates the owner and firmware and bumps last_seen_at.
 * A new firmware value overwrites; omitting it keeps the stored one.
 */
export async function pairDevice(
  farmerId: string,
  input: PairDeviceBody,
  db: Queryable = getPool(),
): Promise<DeviceRow> {
  const { rows } = await db.query<DeviceRow>(
    `INSERT INTO devices (serial, firmware_version, owner_farmer_id, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (serial) DO UPDATE SET
       owner_farmer_id  = EXCLUDED.owner_farmer_id,
       firmware_version = COALESCE(EXCLUDED.firmware_version, devices.firmware_version),
       last_seen_at     = now()
     RETURNING *`,
    [input.serial, input.firmware_version ?? null, farmerId],
  );
  return rows[0];
}

export async function listDevicesByOwner(
  farmerId: string,
  db: Queryable = getPool(),
): Promise<DeviceRow[]> {
  const { rows } = await db.query<DeviceRow>(
    'SELECT * FROM devices WHERE owner_farmer_id = $1 ORDER BY created_at DESC',
    [farmerId],
  );
  return rows;
}

/**
 * Resolve the serial a sync arrived with to a device row, registering it on first
 * sight and bumping `last_seen_at`.
 *
 * Deliberately *not* {@link pairDevice}. Pairing is an explicit act — the farmer
 * says "this stick is mine" — and it overwrites `owner_farmer_id`. A sync must
 * never do that: two farmers demonstrating the same stick, or one farmer's app
 * replaying a frame that names another's serial, would silently transfer the
 * device. So ownership is only ever *filled in* here, never reassigned:
 * `COALESCE(devices.owner_farmer_id, EXCLUDED.owner_farmer_id)` claims an
 * unclaimed device and leaves a claimed one alone.
 *
 * The caller checks `owner_farmer_id` against the authenticated farmer before
 * writing `device_id` onto any reading — see `segregation.service.ts`, which drops
 * the link rather than store a reading against someone else's device.
 */
export async function resolveSyncDevice(
  serial: string,
  farmerId: string,
  firmwareVersion: string | null,
  db: Queryable = getPool(),
): Promise<DeviceRow> {
  const { rows } = await db.query<DeviceRow>(
    `INSERT INTO devices (serial, firmware_version, owner_farmer_id, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (serial) DO UPDATE SET
       owner_farmer_id  = COALESCE(devices.owner_farmer_id, EXCLUDED.owner_farmer_id),
       firmware_version = COALESCE(EXCLUDED.firmware_version, devices.firmware_version),
       last_seen_at     = now()
     RETURNING *`,
    [serial, firmwareVersion, farmerId],
  );
  return rows[0];
}
