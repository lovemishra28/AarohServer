import { type AuthContext } from '../../common/auth-middleware';
import type { PairDeviceBody } from './devices.dto';
import {
  type PublicDevice,
  listDevicesByOwner,
  pairDevice as pairDeviceRow,
  toPublicDevice,
} from './devices.repo';

/** POST /v1/devices/pair — claim a probe for the calling farmer (§6.2). */
export async function pairDevice(auth: AuthContext, input: PairDeviceBody): Promise<PublicDevice> {
  const row = await pairDeviceRow(auth.farmerId, input);
  return toPublicDevice(row);
}

/** GET /v1/devices — the caller's paired devices. */
export async function listDevices(auth: AuthContext): Promise<PublicDevice[]> {
  const rows = await listDevicesByOwner(auth.farmerId);
  return rows.map(toPublicDevice);
}
