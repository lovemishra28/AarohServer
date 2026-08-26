import { Router } from 'express';
import { authenticate, requireAuth } from '../../common/auth-middleware';
import { asyncHandler, parseOrThrow } from '../../common/http';
import { PairDeviceSchema } from './devices.dto';
import { listDevices, pairDevice } from './devices.service';

/** Device routes (§6.2), mounted at /v1/devices. All authenticated. */
export const devicesRouter = Router();
devicesRouter.use(authenticate);

// POST /v1/devices/pair — claim a probe.
devicesRouter.post(
  '/pair',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(PairDeviceSchema, req.body);
    res.status(200).json({ device: await pairDevice(requireAuth(req), input) });
  }),
);

// GET /v1/devices — the caller's devices.
devicesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.status(200).json({ devices: await listDevices(requireAuth(req)) });
  }),
);
