import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { AppError } from './errors';
import { JwtError, verifyJwt } from './jwt';

/** What a verified access token tells us about the caller. */
export interface AuthContext {
  farmerId: string;
  role: string;
}

type WithAuth = Request & { auth?: AuthContext };

/**
 * Require a valid `Authorization: Bearer <jwt>` header. On success attaches
 * `req.auth`; otherwise responds with a 401 envelope. Kept separate from
 * `requireRole` so routes can authenticate without pinning a specific role.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    next(new AppError('UNAUTHENTICATED', 'Missing or malformed Authorization header', 401));
    return;
  }
  try {
    const claims = verifyJwt(header.slice('Bearer '.length).trim(), env.JWT_SECRET);
    (req as WithAuth).auth = { farmerId: claims.sub, role: claims.role };
    next();
  } catch (err) {
    if (err instanceof JwtError) {
      next(new AppError('UNAUTHENTICATED', 'Invalid or expired token', 401));
      return;
    }
    next(err);
  }
}

/**
 * Gate a route to one of the given roles. Must run after {@link authenticate}.
 * A caller whose role is not allowed gets 403; an unauthenticated request that
 * somehow reaches here gets 401.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = (req as WithAuth).auth;
    if (!auth) {
      next(new AppError('UNAUTHENTICATED', 'Authentication required', 401));
      return;
    }
    if (!roles.includes(auth.role)) {
      next(new AppError('FORBIDDEN', `Requires role: ${roles.join(' or ')}`, 403));
      return;
    }
    next();
  };
}

/**
 * Read the authenticated context inside a handler. Throws if called on a route
 * that did not run {@link authenticate} — a programming error, not a client one.
 */
export function requireAuth(req: Request): AuthContext {
  const auth = (req as WithAuth).auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', 'Authentication required', 401);
  return auth;
}

/**
 * Enforce resource ownership. A farmer may only touch rows they own; agents and
 * admins are trusted to act across farmers (field support, moderation). Throws
 * 403 otherwise. Centralised here so every resource applies the same rule.
 */
export function assertOwnership(ownerFarmerId: string, auth: AuthContext): void {
  if (auth.role === 'agent' || auth.role === 'admin') return;
  if (auth.farmerId !== ownerFarmerId) {
    throw new AppError('FORBIDDEN', 'You do not have access to this resource', 403);
  }
}
