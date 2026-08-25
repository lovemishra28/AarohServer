import { Router } from 'express';
import { getHealth } from './health.service';

export const healthRouter = Router();

// GET /v1/health — liveness/readiness (§6.2). Always 200 if the process is up;
// the body reports dependency reachability (e.g. the AI service).
healthRouter.get('/', async (_req, res, next) => {
  try {
    res.status(200).json(await getHealth());
  } catch (err) {
    next(err);
  }
});
