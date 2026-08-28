import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { AppError } from './errors';
import { describeError } from './errors';
import { logger } from './logger';
import { env } from '../config/env';

/**
 * Verification of Google Sign-In ID tokens (used by POST /v1/auth/google).
 *
 * The mobile app never sends us a password or an access token — it sends the
 * **ID token** the native Google SDK produced, which is an RS256 JWT signed by
 * Google. Verifying it here (rather than trusting the client's claim about who it
 * is) is the entire security boundary of "Continue with Google", so this file
 * does the full check: signature against Google's published keys, issuer,
 * audience, and expiry.
 *
 * Done without `google-auth-library`, consistent with `common/jwt.ts` and
 * `common/password.ts`: RS256 verification is `crypto.verify` once the JWK is
 * turned into a KeyObject, which Node can do natively (`format: 'jwk'`).
 *
 * ── Why the audience check matters ────────────────────────────────────────────
 * Anyone can obtain a valid, correctly-signed Google ID token — for *their own*
 * app. Without an `aud` check, a token minted for some unrelated application
 * would be accepted here, letting its holder log in as that Google user. So
 * `aud` MUST equal our own client ID. The native SDK is configured with the
 * **web** client ID (`webClientId`), so that is the audience it mints, on Android
 * and iOS alike.
 */

/** The subset of Google's ID-token claims we rely on. */
export interface GoogleIdentity {
  /** Google's stable, immutable user id. The durable key — emails can change. */
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

const VALID_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * Small clock-skew allowance. Phones with a slightly fast clock otherwise
 * present a token whose `iat` is in our future; 60 s is the conventional slack.
 */
const CLOCK_SKEW_S = 60;

/** Cached signing keys. Google rotates them, hence the expiry rather than forever. */
let keyCache: { keys: Map<string, KeyObject>; expiresAt: number } | null = null;

function audiences(): string[] {
  const extra = env.GOOGLE_EXTRA_AUDIENCES.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [env.GOOGLE_WEB_CLIENT_ID, ...extra].filter(Boolean);
}

/** True when the server is configured to accept Google sign-in at all. */
export function isGoogleConfigured(): boolean {
  return env.GOOGLE_WEB_CLIENT_ID.length > 0;
}

/** Seconds to cache the JWKS, read from the response's Cache-Control max-age. */
function cacheSecondsFrom(response: Response): number {
  const header = response.headers.get('cache-control') ?? '';
  const match = /max-age=(\d+)/i.exec(header);
  const parsed = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 3600;
  // Clamp: long enough to avoid hammering Google, short enough to pick up a
  // rotation without a restart.
  return Math.min(Math.max(parsed, 300), 86_400);
}

async function fetchKeys(): Promise<Map<string, KeyObject>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.GOOGLE_JWKS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(env.GOOGLE_JWKS_URL, { signal: controller.signal });
  } catch (err) {
    logger.error('google_jwks_fetch_failed', describeError(err));
    throw new AppError(
      'GOOGLE_KEYS_UNAVAILABLE',
      "Could not reach Google's key service. Try again.",
      503,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    logger.error('google_jwks_bad_status', { status: response.status });
    throw new AppError(
      'GOOGLE_KEYS_UNAVAILABLE',
      "Google's key service returned an error. Try again.",
      503,
    );
  }

  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    // Only RSA signing keys are usable for the RS256 tokens Google issues.
    if (!jwk.kid || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
    } catch (err) {
      logger.warn('google_jwk_unusable', { kid: jwk.kid, ...describeError(err) });
    }
  }
  if (keys.size === 0) {
    throw new AppError('GOOGLE_KEYS_UNAVAILABLE', "Google's key set was empty.", 503);
  }

  keyCache = { keys, expiresAt: Date.now() + cacheSecondsFrom(response) * 1000 };
  return keys;
}

/**
 * Resolve a `kid` to a public key, refreshing the cache once if it is unknown.
 * The single forced refresh is what makes a key rotation self-healing: a token
 * signed with a brand-new key would otherwise fail until the cache expired.
 */
async function keyFor(kid: string): Promise<KeyObject> {
  if (keyCache && keyCache.expiresAt > Date.now()) {
    const cached = keyCache.keys.get(kid);
    if (cached) return cached;
  }
  const fresh = await fetchKeys();
  const key = fresh.get(kid);
  if (!key) {
    throw new AppError('GOOGLE_TOKEN_INVALID', 'Google token was signed with an unknown key.', 401);
  }
  return key;
}

/** Test seam: drop the cached JWKS so the next verify refetches. */
export function resetGoogleKeyCache(): void {
  keyCache = null;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

function invalid(reason: string): AppError {
  // The reason is logged, not returned: the client only needs "this didn't work",
  // and detailed token diagnostics are an information leak.
  logger.warn('google_token_rejected', { reason });
  return new AppError('GOOGLE_TOKEN_INVALID', 'Google sign-in could not be verified.', 401);
}

/**
 * Verify a Google ID token and return the identity it asserts.
 * Throws an {@link AppError} (401 for a bad token, 503 if Google is unreachable).
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!isGoogleConfigured()) {
    throw new AppError(
      'GOOGLE_NOT_CONFIGURED',
      'Google sign-in is not configured on this server.',
      503,
    );
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) throw invalid('malformed');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header: { alg?: string; kid?: string };
  let payload: {
    iss?: string;
    aud?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean | string;
    name?: string;
    picture?: string;
  };
  try {
    header = decodeSegment(encodedHeader);
    payload = decodeSegment(encodedPayload);
  } catch {
    throw invalid('undecodable');
  }

  // Pin the algorithm before touching the signature: accepting whatever `alg`
  // the token names is the classic JWT confusion bug.
  if (header.alg !== 'RS256') throw invalid(`unexpected alg ${String(header.alg)}`);
  if (!header.kid) throw invalid('no kid');

  const key = await keyFor(header.kid);
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8');
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (!cryptoVerify('RSA-SHA256', signingInput, key, signature)) {
    throw invalid('bad signature');
  }

  if (!payload.iss || !VALID_ISSUERS.has(payload.iss)) throw invalid(`issuer ${String(payload.iss)}`);

  if (!payload.aud || !audiences().includes(payload.aud)) {
    throw invalid('audience mismatch');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < now) throw invalid('expired');
  if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > now) {
    throw invalid('issued in the future');
  }
  if (!payload.sub) throw invalid('no sub');

  // Google serialises this as a boolean, but has historically also sent the
  // string "true" — accept both rather than silently treating it as unverified.
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';

  return {
    sub: payload.sub,
    email: payload.email ? payload.email.trim().toLowerCase() : null,
    emailVerified,
    name: payload.name ?? null,
    picture: payload.picture ?? null,
  };
}
