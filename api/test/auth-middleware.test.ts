import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  type AuthContext,
  assertOwnership,
  requireAuth,
  requireRole,
} from '../src/common/auth-middleware';
import { AppError } from '../src/common/errors';

const farmer: AuthContext = { farmerId: 'farmer-1', role: 'farmer' };
const agent: AuthContext = { farmerId: 'agent-9', role: 'agent' };
const admin: AuthContext = { farmerId: 'admin-9', role: 'admin' };

function reqWith(auth?: AuthContext): Request {
  return { auth } as unknown as Request;
}

describe('assertOwnership', () => {
  it('allows a farmer to touch their own resource', () => {
    expect(() => assertOwnership('farmer-1', farmer)).not.toThrow();
  });

  it("forbids a farmer touching another farmer's resource", () => {
    try {
      assertOwnership('someone-else', farmer);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(403);
      expect((err as AppError).code).toBe('FORBIDDEN');
    }
  });

  it('lets agents and admins act across farmers', () => {
    expect(() => assertOwnership('any-farmer', agent)).not.toThrow();
    expect(() => assertOwnership('any-farmer', admin)).not.toThrow();
  });
});

describe('requireRole', () => {
  it('calls next() with no error when the role is allowed', () => {
    const next = vi.fn();
    requireRole('agent', 'admin')(reqWith(agent), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('passes a 403 to next() when the role is not allowed', () => {
    const next = vi.fn();
    requireRole('admin')(reqWith(farmer), {} as Response, next);
    const err = next.mock.calls[0][0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(403);
  });

  it('passes a 401 to next() when unauthenticated', () => {
    const next = vi.fn();
    requireRole('farmer')(reqWith(undefined), {} as Response, next);
    const err = next.mock.calls[0][0] as AppError;
    expect(err.status).toBe(401);
  });
});

describe('requireAuth', () => {
  it('returns the context when present', () => {
    expect(requireAuth(reqWith(farmer))).toEqual(farmer);
  });

  it('throws 401 when the route was not authenticated', () => {
    expect(() => requireAuth(reqWith(undefined))).toThrow(AppError);
  });
});
