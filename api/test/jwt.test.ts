import { describe, expect, it } from 'vitest';
import { JwtError, signJwt, verifyJwt } from '../src/common/jwt';

const SECRET = 'test-secret-at-least-16-chars';

describe('jwt (HS256, node:crypto)', () => {
  it('round-trips claims and stamps iss/iat/exp', () => {
    const token = signJwt({ sub: 'farmer-1', role: 'farmer', typ: 'access' }, SECRET, 900);
    const claims = verifyJwt(token, SECRET);

    expect(claims.sub).toBe('farmer-1');
    expect(claims.role).toBe('farmer');
    expect(claims.iss).toBe('aaroh');
    expect(typeof claims.iat).toBe('number');
    expect(claims.exp).toBe((claims.iat as number) + 900);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signJwt({ sub: 'f', role: 'farmer' }, SECRET, 900);
    expect(() => verifyJwt(token, 'a-totally-different-secret')).toThrow(JwtError);
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = signJwt({ sub: 'f', role: 'farmer' }, SECRET, 900);
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'f', role: 'admin' }), 'utf8').toString(
      'base64url',
    );
    expect(() => verifyJwt(`${h}.${forged}.${s}`, SECRET)).toThrow(/bad signature/);
  });

  it('rejects an expired token', () => {
    const token = signJwt({ sub: 'f', role: 'farmer' }, SECRET, -1); // already expired
    expect(() => verifyJwt(token, SECRET)).toThrow(/expired/);
  });

  it('rejects a structurally malformed token', () => {
    expect(() => verifyJwt('not-a-jwt', SECRET)).toThrow(/malformed/);
    expect(() => verifyJwt('a.b', SECRET)).toThrow(/malformed/);
  });
});
