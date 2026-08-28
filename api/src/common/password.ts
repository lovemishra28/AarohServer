import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../config/env';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing for email + password sign-in.
 *
 * scrypt from `node:crypto` — deliberately not bcrypt or argon2, for the same
 * reason `common/jwt.ts` hand-rolls HS256: this project takes no third-party
 * crypto dependency (the build sandbox has no network). scrypt is memory-hard
 * and is the only password-grade KDF in Node's standard library, so it is the
 * right tool here rather than a compromise.
 *
 * Stored format — self-describing, `$`-delimited:
 *
 *     scrypt$<cost>$<r>$<p>$<salt-base64url>$<hash-base64url>
 *
 * The parameters travel *with* the hash, so raising PASSWORD_SCRYPT_COST later
 * does not invalidate existing passwords: {@link verifyPassword} re-derives with
 * whatever each row was created with. That is what makes the work factor
 * tunable in production instead of a one-way door.
 */

const SCHEME = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * scrypt refuses to run if it would exceed `maxmem` (default 32 MB), and cost 15
 * needs ~128 MB, so the budget has to be derived from the parameters rather than
 * left at the default — otherwise hashing throws instead of being slow.
 * Memory ≈ 128 · N · r bytes; doubled for headroom over Node's internal
 * bookkeeping.
 */
function maxmemFor(N: number, r: number): number {
  return 256 * N * r + 1024 * 1024;
}

async function derive(
  password: string,
  salt: Buffer,
  cost: number,
  r: number,
  p: number,
): Promise<Buffer> {
  const N = 2 ** cost;
  return scrypt(password.normalize('NFKC'), salt, KEY_BYTES, {
    N,
    r,
    p,
    maxmem: maxmemFor(N, r),
  });
}

/** Hash a plaintext password for storage in `farmers.password_hash`. */
export async function hashPassword(password: string): Promise<string> {
  const cost = env.PASSWORD_SCRYPT_COST;
  const r = env.PASSWORD_SCRYPT_BLOCK_SIZE;
  const p = env.PASSWORD_SCRYPT_PARALLELISM;
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, cost, r, p);
  return [SCHEME, cost, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/**
 * Check a plaintext password against a stored hash.
 *
 * Returns false — never throws — for a malformed or unknown-scheme hash, so a
 * corrupted row behaves as "wrong password" instead of turning into a 500 that
 * tells an attacker something about the account.
 *
 * NOTE on Unicode: the password is NFKC-normalised on both hash and verify, so a
 * passphrase containing composed vs decomposed accents (or Devanagari typed by a
 * different keyboard) still matches.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return false;

  const cost = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(cost) || cost < 1 || cost > 24) return false;
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await derive(password, salt, cost, r, p);
  } catch {
    return false;
  }

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * True when a stored hash was produced with parameters weaker than the current
 * configuration — the signal to transparently re-hash on the next successful
 * login, which is how a work-factor increase actually reaches existing accounts.
 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return true;
  return Number(parts[1]) < env.PASSWORD_SCRYPT_COST;
}
