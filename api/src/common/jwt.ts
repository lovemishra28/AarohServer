import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JSON Web Tokens on top of `node:crypto` — no third-party
 * library. This is a deliberate choice, not a shortcut: the build/CI sandbox has
 * no network to add `jsonwebtoken`, and HS256 is a dozen auditable lines. We
 * implement exactly the surface we use (sign + verify with expiry) rather than a
 * general JWT toolkit.
 *
 * Tokens are `base64url(header).base64url(payload).base64url(signature)` where
 * the signature is `HMAC-SHA256(secret, header.payload)`.
 */

/** Thrown for any invalid/expired/tampered token. Callers map this to 401. */
export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

/** Registered + custom claims we use. `sub` is the farmer id; `role` gates RBAC. */
export interface JwtClaims {
  sub: string;
  role: string;
  /** Distinguishes access tokens from refresh usage if ever embedded. */
  typ?: 'access';
  /** Issued-at and expiry, seconds since epoch. Set by {@link signJwt}. */
  iat?: number;
  exp?: number;
  iss?: string;
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;
const ISSUER = 'aaroh';

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/**
 * Sign a JWT that expires `ttlSeconds` from now.
 * Adds `iat`, `exp` and `iss`; the caller supplies `sub` and `role`.
 */
export function signJwt(
  claims: Pick<JwtClaims, 'sub' | 'role' | 'typ'>,
  secret: string,
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtClaims = {
    ...claims,
    iss: ISSUER,
    iat: now,
    exp: now + ttlSeconds,
  };
  const signingInput = `${encodeSegment(HEADER)}.${encodeSegment(payload)}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

/**
 * Verify signature + expiry and return the claims. Throws {@link JwtError} on any
 * problem — wrong shape, bad signature, or past `exp`. Signature comparison is
 * constant-time to avoid leaking validity through timing.
 */
export function verifyJwt(token: string, secret: string): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [encodedHeader, encodedPayload, providedSig] = parts;

  const expectedSig = sign(`${encodedHeader}.${encodedPayload}`, secret);
  const provided = Buffer.from(providedSig, 'base64url');
  const expected = Buffer.from(expectedSig, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new JwtError('bad signature');
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    throw new JwtError('unreadable payload');
  }

  if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) {
    throw new JwtError('token expired');
  }
  if (typeof claims.sub !== 'string' || typeof claims.role !== 'string') {
    throw new JwtError('missing sub/role');
  }
  return claims;
}
