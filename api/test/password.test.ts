import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { hashPassword, needsRehash, verifyPassword } from '../src/common/password';

/**
 * scrypt is intentionally slow — at the production cost (15 → ~128 MB, ~1 s per
 * hash) a handful of round-trips would dominate the whole suite. The parameters
 * are read per call, so the tests turn the work factor down to the schema minimum
 * and restore it afterwards. What is under test is the *format contract* and the
 * comparison logic, neither of which depends on the cost.
 */
const REAL_COST = env.PASSWORD_SCRYPT_COST;
const TEST_COST = 12;

beforeAll(() => {
  env.PASSWORD_SCRYPT_COST = TEST_COST;
});

afterAll(() => {
  env.PASSWORD_SCRYPT_COST = REAL_COST;
});

describe('hashPassword / verifyPassword (scrypt, node:crypto)', () => {
  it('round-trips a password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse 7');

    expect(await verifyPassword('correct horse 7', stored)).toBe(true);
    expect(await verifyPassword('correct horse 8', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('embeds the parameters so the hash is self-describing', async () => {
    const stored = await hashPassword('pass1234');
    const [scheme, cost, r, p, salt, hash] = stored.split('$');

    expect(scheme).toBe('scrypt');
    expect(Number(cost)).toBe(TEST_COST);
    expect(Number(r)).toBe(env.PASSWORD_SCRYPT_BLOCK_SIZE);
    expect(Number(p)).toBe(env.PASSWORD_SCRYPT_PARALLELISM);
    // base64url: no +, / or = padding, so the hash is safe in any text column.
    expect(salt).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('salts every hash (same password, different stored value)', async () => {
    const a = await hashPassword('pass1234');
    const b = await hashPassword('pass1234');

    expect(a).not.toBe(b);
    expect(await verifyPassword('pass1234', a)).toBe(true);
    expect(await verifyPassword('pass1234', b)).toBe(true);
  });

  it('still verifies a hash made with weaker parameters', async () => {
    // A row written before the work factor was raised must keep working — this is
    // the whole point of storing the cost alongside the hash.
    const old = await hashPassword('pass1234');
    env.PASSWORD_SCRYPT_COST = TEST_COST + 1;
    try {
      expect(await verifyPassword('pass1234', old)).toBe(true);
    } finally {
      env.PASSWORD_SCRYPT_COST = TEST_COST;
    }
  });

  it('normalises Unicode so the same passphrase matches either encoding', async () => {
    // "é" composed (U+00E9) vs decomposed (e + U+0301) — different bytes, same
    // passphrase as far as the farmer is concerned.
    const stored = await hashPassword('café 1234');
    expect(await verifyPassword('café 1234', stored)).toBe(true);
  });

  it('treats a malformed or unknown-scheme hash as a wrong password, never a throw', async () => {
    for (const junk of [
      '',
      'not-a-hash',
      'bcrypt$12$8$1$c2FsdA$aGFzaA',
      'scrypt$12$8$1$c2FsdA', // too few segments
      'scrypt$abc$8$1$c2FsdA$aGFzaA', // non-numeric cost
      'scrypt$99$8$1$c2FsdA$aGFzaA', // absurd cost
      'scrypt$12$0$1$c2FsdA$aGFzaA', // r = 0
      'scrypt$12$8$1$$aGFzaA', // empty salt
    ]) {
      expect(await verifyPassword('pass1234', junk)).toBe(false);
    }
  });
});

describe('needsRehash', () => {
  it('is false at the current cost and true below it', async () => {
    const stored = await hashPassword('pass1234');
    expect(needsRehash(stored)).toBe(false);

    env.PASSWORD_SCRYPT_COST = TEST_COST + 2;
    try {
      expect(needsRehash(stored)).toBe(true);
    } finally {
      env.PASSWORD_SCRYPT_COST = TEST_COST;
    }
  });

  it('is true for anything it cannot read, so a legacy row gets replaced on login', () => {
    expect(needsRehash('bcrypt$12$whatever')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});
