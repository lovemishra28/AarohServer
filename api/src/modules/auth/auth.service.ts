import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { getPool, withClient, type Queryable } from '../../common/db';
import { AppError } from '../../common/errors';
import { signJwt } from '../../common/jwt';
import { logger } from '../../common/logger';
import { env } from '../../config/env';
import {
  type FarmerRow,
  type PublicFarmer,
  toPublicFarmer,
  upsertFarmerByPhone,
} from '../farmers/farmers.repo';

export interface OtpRow {
  id: string;
  phone: string | null;
  email: string | null;
  code: string;
  purpose: string;
  expires_at: Date;
  consumed_at: Date | null;
  attempts: number;
  created_at: Date;
}

/** OAuth-style token bundle returned to clients. */
export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  role: string;
}

/** What every provider route resolves to — one shape, one response envelope. */
export interface AuthResult {
  farmer: PublicFarmer;
  tokens: TokenBundle;
}

export interface OtpRequestResult {
  sent: true;
  expires_in_s: number;
  /** Present only outside production (dev stub has no SMS) so curl/tests work. */
  dev_code?: string;
}

export const isProd = env.NODE_ENV === 'production';

/** Constant-time string comparison that tolerates unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Issue an access JWT + a fresh opaque refresh token, persisting only the SHA-256
 * of the refresh token so it can be revoked. Runs on whatever `Queryable` it is
 * given so it can join the verify/refresh transactions.
 *
 * Exported because every provider — phone OTP, email+password, email OTP, and
 * Google — must mint sessions *identically*. A second implementation is how a
 * back door gets added by accident.
 */
export async function issueTokens(farmer: FarmerRow, db: Queryable): Promise<TokenBundle> {
  const accessToken = signJwt(
    { sub: farmer.id, role: farmer.role, typ: 'access' },
    env.JWT_SECRET,
    env.JWT_ACCESS_TTL_S,
  );

  const refreshToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_S * 1000);
  await db.query(
    'INSERT INTO refresh_tokens (farmer_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [farmer.id, sha256(refreshToken), expiresAt],
  );

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: env.JWT_ACCESS_TTL_S,
    role: farmer.role,
  };
}

/**
 * Issue a one-time login code for a phone (§6.1). Rate-limited per phone. In the
 * dev stub there is no SMS provider: the code is `OTP_DEV_CODE` when set, else a
 * random 6-digit number; either way it is logged and (outside production)
 * returned in the response so the flow is testable end-to-end.
 */
export async function requestOtp(phone: string): Promise<OtpRequestResult> {
  const pool = getPool();

  const { rows: recent } = await pool.query<{ count: string }>(
    "SELECT count(*)::int AS count FROM otp_challenges WHERE phone = $1 AND created_at > now() - interval '1 hour'",
    [phone],
  );
  if (Number(recent[0]?.count ?? 0) >= env.OTP_MAX_PER_HOUR) {
    throw new AppError('OTP_RATE_LIMITED', 'Too many code requests. Try again later.', 429);
  }

  const code = env.OTP_DEV_CODE ? env.OTP_DEV_CODE : randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + env.OTP_TTL_S * 1000);
  await pool.query(
    "INSERT INTO otp_challenges (phone, code, purpose, expires_at) VALUES ($1, $2, 'login', $3)",
    [phone, code, expiresAt],
  );

  // Dev stub: this log line stands in for the SMS. Never logged in production.
  if (!isProd) logger.info('otp_issued_dev', { phone, code, expires_in_s: env.OTP_TTL_S });

  return {
    sent: true,
    expires_in_s: env.OTP_TTL_S,
    ...(isProd ? {} : { dev_code: code }),
  };
}

/**
 * Reject a challenge that cannot be redeemed, and count a wrong code against it.
 *
 * Shared by the phone and email flows so both enforce the same rules — expiry,
 * a hard attempt ceiling, single use — from one place. `attempts` is incremented
 * on the *server* copy rather than trusting the client to stop retrying, which is
 * what makes a 6-digit code safe: 5 guesses out of a million, not unlimited.
 */
export async function redeemChallenge(
  challenge: OtpRow | undefined,
  code: string,
  labels: { missing: string; expired: string },
  db: Queryable = getPool(),
): Promise<OtpRow> {
  if (!challenge || challenge.consumed_at) {
    throw new AppError('OTP_INVALID', labels.missing, 401);
  }
  if (challenge.expires_at.getTime() < Date.now()) {
    throw new AppError('OTP_EXPIRED', labels.expired, 401);
  }
  if (challenge.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw new AppError('OTP_LOCKED', 'Too many attempts. Request a new code.', 429);
  }
  if (!safeEqual(challenge.code, code)) {
    await db.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [
      challenge.id,
    ]);
    throw new AppError('OTP_INVALID', 'Incorrect code.', 401);
  }
  return challenge;
}

/**
 * Verify a code and log the farmer in, creating the farmer on first login
 * (§6.1). Mismatches increment the attempt counter and eventually lock the
 * challenge; success consumes it and issues tokens — all in one transaction.
 */
export async function verifyOtp(phone: string, code: string): Promise<AuthResult> {
  const pool = getPool();
  const { rows } = await pool.query<OtpRow>(
    "SELECT * FROM otp_challenges WHERE phone = $1 AND purpose = 'login' ORDER BY created_at DESC LIMIT 1",
    [phone],
  );
  const challenge = await redeemChallenge(rows[0], code, {
    missing: 'No active code for this number. Request a new one.',
    expired: 'This code has expired. Request a new one.',
  });

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [
        challenge.id,
      ]);
      const farmer = await upsertFarmerByPhone(phone, client);
      const tokens = await issueTokens(farmer, client);
      await client.query('COMMIT');
      logger.info('login_ok', { farmer_id: farmer.id, role: farmer.role, provider: 'phone' });
      return { farmer: toPublicFarmer(farmer), tokens };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/**
 * Exchange a valid refresh token for a new token bundle, rotating the refresh
 * token (revoke the old, issue a new) so a leaked token has a bounded life. The
 * row is locked FOR UPDATE to make concurrent refreshes safe.
 */
export async function refresh(rawToken: string): Promise<TokenBundle> {
  const tokenHash = sha256(rawToken);
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query<{
        id: string;
        farmer_id: string;
        expires_at: Date;
        revoked_at: Date | null;
      }>('SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [tokenHash]);
      const token = rows[0];

      if (!token || token.revoked_at) {
        throw new AppError('REFRESH_INVALID', 'Refresh token is invalid or revoked.', 401);
      }
      if (token.expires_at.getTime() < Date.now()) {
        throw new AppError('REFRESH_EXPIRED', 'Refresh token has expired. Log in again.', 401);
      }

      const { rows: farmers } = await client.query<FarmerRow>(
        'SELECT * FROM farmers WHERE id = $1',
        [token.farmer_id],
      );
      const farmer = farmers[0];
      if (!farmer) throw new AppError('REFRESH_INVALID', 'Account no longer exists.', 401);

      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [token.id]);
      const tokens = await issueTokens(farmer, client);
      await client.query('COMMIT');
      return tokens;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/**
 * Revoke a refresh token at sign-out. Without this the client only *forgets* the
 * token while the row stays valid for its full 30 days — anyone who lifted it off
 * a shared or lost phone could still mint fresh access tokens long after the
 * farmer signed out. Revoking server-side is what makes sign-out mean something.
 *
 * `all: true` revokes every live session for the same farmer ("sign out
 * everywhere"), which is also what a password reset does.
 *
 * Deliberately silent about unknown or already-revoked tokens: sign-out must
 * always succeed so the client can clear local state unconditionally, and an
 * error here would only tell an attacker whether the token they hold is live.
 */
export async function logout(rawToken: string, all = false): Promise<{ revoked: number }> {
  const tokenHash = sha256(rawToken);
  return withClient(async (client) => {
    const { rows } = await client.query<{ farmer_id: string }>(
      'SELECT farmer_id FROM refresh_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    const farmerId = rows[0]?.farmer_id;
    if (!farmerId) return { revoked: 0 };

    const result = all
      ? await client.query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE farmer_id = $1 AND revoked_at IS NULL',
          [farmerId],
        )
      : await client.query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
          [tokenHash],
        );
    return { revoked: result.rowCount ?? 0 };
  });
}
