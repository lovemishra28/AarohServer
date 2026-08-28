import { createServer, type Server } from 'node:http';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors';
import {
  isGoogleConfigured,
  resetGoogleKeyCache,
  verifyGoogleIdToken,
} from '../src/common/google-oauth';
import { env } from '../src/config/env';

/**
 * Google ID-token verification, tested against a *local* JWKS.
 *
 * The point of pointing GOOGLE_JWKS_URL at a throwaway http server is that we can
 * hold the signing key ourselves and therefore mint tokens that are genuinely
 * valid — which is the only way to prove that each individual check (alg, issuer,
 * audience, expiry, signature) is the thing doing the rejecting, rather than the
 * token being broken for some unrelated reason.
 */

const CLIENT_ID = '1234567890-test.apps.googleusercontent.com';
const KID = 'test-key-1';

let privateKey: KeyObject;
let server: Server;
let jwksHits = 0;
let jwksBody: string;

const realJwksUrl = env.GOOGLE_JWKS_URL;
const realClientId = env.GOOGLE_WEB_CLIENT_ID;
const realExtra = env.GOOGLE_EXTRA_AUDIENCES;

function b64url(value: object | Buffer): string {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8');
  return buf.toString('base64url');
}

/** Mint a signed token; every field is overridable so each check can be isolated. */
function makeToken(
  overrides: {
    header?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    tamper?: boolean;
    key?: KeyObject;
  } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KID, typ: 'JWT', ...overrides.header };
  const payload = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '109876543210987654321',
    email: 'Farmer@Example.com',
    email_verified: true,
    name: 'Test Farmer',
    picture: 'https://example.com/p.png',
    iat: now,
    exp: now + 3600,
    ...overrides.payload,
  };

  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = cryptoSign(
    'RSA-SHA256',
    Buffer.from(overrides.tamper ? `${signingInput}x` : signingInput, 'utf8'),
    overrides.key ?? privateKey,
  );
  return `${signingInput}.${b64url(signature)}`;
}

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;

  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwksBody = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });

  server = createServer((_req, res) => {
    jwksHits += 1;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=3600' });
    res.end(jwksBody);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  env.GOOGLE_JWKS_URL = `http://127.0.0.1:${port}/certs`;
  env.GOOGLE_WEB_CLIENT_ID = CLIENT_ID;
  env.GOOGLE_EXTRA_AUDIENCES = '';
});

afterAll(async () => {
  env.GOOGLE_JWKS_URL = realJwksUrl;
  env.GOOGLE_WEB_CLIENT_ID = realClientId;
  env.GOOGLE_EXTRA_AUDIENCES = realExtra;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  resetGoogleKeyCache();
});

/** Assert the call fails with a specific AppError code, not just "it threw". */
async function expectRejection(token: string, code: string): Promise<void> {
  await expect(verifyGoogleIdToken(token)).rejects.toMatchObject({ code });
  await expect(verifyGoogleIdToken(token)).rejects.toBeInstanceOf(AppError);
}

describe('verifyGoogleIdToken — accepting a real token', () => {
  it('returns the identity and canonicalises the email', async () => {
    const identity = await verifyGoogleIdToken(makeToken());

    expect(identity.sub).toBe('109876543210987654321');
    expect(identity.email).toBe('farmer@example.com'); // lower-cased for the unique index
    expect(identity.emailVerified).toBe(true);
    expect(identity.name).toBe('Test Farmer');
  });

  it("accepts email_verified as the string 'true' Google has historically sent", async () => {
    const identity = await verifyGoogleIdToken(
      makeToken({ payload: { email_verified: 'true' } }),
    );
    expect(identity.emailVerified).toBe(true);
  });

  it('treats a missing email_verified as unverified rather than assuming', async () => {
    const identity = await verifyGoogleIdToken(makeToken({ payload: { email_verified: undefined } }));
    expect(identity.emailVerified).toBe(false);
  });

  it('accepts the bare `accounts.google.com` issuer form too', async () => {
    const identity = await verifyGoogleIdToken(
      makeToken({ payload: { iss: 'accounts.google.com' } }),
    );
    expect(identity.sub).toBe('109876543210987654321');
  });

  it('accepts an audience listed in GOOGLE_EXTRA_AUDIENCES', async () => {
    env.GOOGLE_EXTRA_AUDIENCES = 'ios-client.apps.googleusercontent.com, spare.example';
    try {
      const identity = await verifyGoogleIdToken(
        makeToken({ payload: { aud: 'ios-client.apps.googleusercontent.com' } }),
      );
      expect(identity.sub).toBe('109876543210987654321');
    } finally {
      env.GOOGLE_EXTRA_AUDIENCES = '';
    }
  });

  it('caches the key set instead of refetching per verification', async () => {
    const before = jwksHits;
    await verifyGoogleIdToken(makeToken());
    await verifyGoogleIdToken(makeToken());
    expect(jwksHits).toBe(before + 1);
  });

  it('refetches once for an unknown kid, so a key rotation self-heals', async () => {
    await verifyGoogleIdToken(makeToken()); // warm the cache
    const before = jwksHits;
    // A token naming a kid we have never seen: the cache must be refreshed before
    // giving up. Here the refresh still will not contain it, so it fails — but the
    // fetch itself is the behaviour under test.
    await expectRejection(makeToken({ header: { kid: 'rotated-key' } }), 'GOOGLE_TOKEN_INVALID');
    expect(jwksHits).toBeGreaterThan(before);
  });
});

describe('verifyGoogleIdToken — rejections', () => {
  it('rejects a token signed by someone else', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expectRejection(makeToken({ key: other.privateKey }), 'GOOGLE_TOKEN_INVALID');
  });

  it('rejects a tampered signing input', async () => {
    await expectRejection(makeToken({ tamper: true }), 'GOOGLE_TOKEN_INVALID');
  });

  it('rejects alg=none and HS256 — the JWT confusion attacks', async () => {
    await expectRejection(makeToken({ header: { alg: 'none' } }), 'GOOGLE_TOKEN_INVALID');
    await expectRejection(makeToken({ header: { alg: 'HS256' } }), 'GOOGLE_TOKEN_INVALID');
  });

  it("rejects a token minted for another app (this is the check that stops impersonation)", async () => {
    await expectRejection(
      makeToken({ payload: { aud: 'someone-elses-app.apps.googleusercontent.com' } }),
      'GOOGLE_TOKEN_INVALID',
    );
  });

  it('rejects a foreign issuer', async () => {
    await expectRejection(
      makeToken({ payload: { iss: 'https://evil.example.com' } }),
      'GOOGLE_TOKEN_INVALID',
    );
  });

  it('rejects an expired token, and one issued too far in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectRejection(makeToken({ payload: { exp: now - 3600 } }), 'GOOGLE_TOKEN_INVALID');
    await expectRejection(
      makeToken({ payload: { iat: now + 3600, exp: now + 7200 } }),
      'GOOGLE_TOKEN_INVALID',
    );
  });

  it('rejects a token with no sub, no kid, or a malformed shape', async () => {
    await expectRejection(makeToken({ payload: { sub: undefined } }), 'GOOGLE_TOKEN_INVALID');
    await expectRejection(makeToken({ header: { kid: undefined } }), 'GOOGLE_TOKEN_INVALID');
    await expectRejection('not.a.jwt', 'GOOGLE_TOKEN_INVALID');
    await expectRejection('only-one-segment', 'GOOGLE_TOKEN_INVALID');
  });

  it('reports 503 GOOGLE_NOT_CONFIGURED when no client ID is set', async () => {
    env.GOOGLE_WEB_CLIENT_ID = '';
    try {
      expect(isGoogleConfigured()).toBe(false);
      await expect(verifyGoogleIdToken(makeToken())).rejects.toMatchObject({
        code: 'GOOGLE_NOT_CONFIGURED',
        status: 503,
      });
    } finally {
      env.GOOGLE_WEB_CLIENT_ID = CLIENT_ID;
    }
  });

  it("reports 503 GOOGLE_KEYS_UNAVAILABLE when Google's keys cannot be fetched", async () => {
    const good = env.GOOGLE_JWKS_URL;
    // Port 1 is reserved and nothing listens there, so the fetch fails fast.
    env.GOOGLE_JWKS_URL = 'http://127.0.0.1:1/certs';
    try {
      await expect(verifyGoogleIdToken(makeToken())).rejects.toMatchObject({
        code: 'GOOGLE_KEYS_UNAVAILABLE',
        status: 503,
      });
    } finally {
      env.GOOGLE_JWKS_URL = good;
    }
  });

  it('never leaks the rejection reason to the caller', async () => {
    // Every 401 path must produce the same opaque message; the specifics are
    // logged instead, so an attacker cannot probe which check they tripped.
    const messages = new Set<string>();
    for (const token of [
      makeToken({ payload: { aud: 'other' } }),
      makeToken({ payload: { iss: 'https://evil.example.com' } }),
      makeToken({ tamper: true }),
    ]) {
      try {
        await verifyGoogleIdToken(token);
      } catch (err) {
        messages.add((err as AppError).message);
      }
    }
    expect(messages.size).toBe(1);
  });
});
