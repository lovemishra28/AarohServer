import { randomInt } from 'node:crypto';
import { getPool, withClient, type Queryable } from '../../common/db';
import { AppError, describeError } from '../../common/errors';
import { logger } from '../../common/logger';
import { sendMail } from '../../common/mailer';
import { hashPassword, needsRehash, verifyPassword } from '../../common/password';
import { env } from '../../config/env';
import {
  createEmailFarmer,
  findFarmerByEmail,
  isUniqueViolation,
  markEmailVerified,
  normalizeEmail,
  setPasswordHash,
  toPublicFarmer,
  type FarmerRow,
} from '../farmers/farmers.repo';
import {
  isProd,
  issueTokens,
  redeemChallenge,
  type AuthResult,
  type OtpRequestResult,
  type OtpRow,
} from './auth.service';

/**
 * Email authentication: password sign-up/sign-in, email one-time codes, and
 * password reset (README §5 "Authentication providers").
 *
 * Everything funnels into the same `issueTokens` the phone flow uses, so a
 * session created here is indistinguishable from any other — one token format,
 * one refresh path, one revocation story.
 *
 * ── Two properties this file works hard to keep ───────────────────────────────
 *
 * 1. **No account enumeration.** "Wrong password" and "no such account" return
 *    the identical 401, and a wrong address still costs a real scrypt derivation
 *    (see `verifyDummy`) so the *timing* does not answer the question the error
 *    message refused to. Likewise, requesting a reset code for an unknown address
 *    reports success. Otherwise this endpoint becomes a free "is this farmer a
 *    customer?" oracle for anyone with a phone number list.
 *
 * 2. **A code is a credential.** Email codes reuse `redeemChallenge`, which means
 *    the same expiry, attempt ceiling, and single-use consumption as SMS codes.
 */

/** Long-lived throwaway hash: verifying against it burns the same CPU as a real check. */
let dummyHashPromise: Promise<string> | null = null;

/**
 * Spend a password verification on a request for an address that does not exist,
 * so "unknown account" and "wrong password" take the same wall-clock time. The
 * hash is computed once per process and reused — the point is the *verify* cost,
 * which is where the timing signal would otherwise be.
 */
async function verifyDummy(password: string): Promise<void> {
  dummyHashPromise ??= hashPassword('timing-equalisation-placeholder');
  await verifyPassword(password, await dummyHashPromise);
}

function newCode(): string {
  return env.OTP_DEV_CODE ? env.OTP_DEV_CODE : randomInt(100000, 1000000).toString();
}

type EmailPurpose = 'login' | 'email_verify' | 'password_reset';

/** Subject + body per purpose. Bilingual: the app defaults to Hindi. */
function composeCodeEmail(
  code: string,
  purpose: EmailPurpose,
): { subject: string; text: string } {
  const minutes = Math.round(env.EMAIL_OTP_TTL_S / 60);
  const lines: Record<EmailPurpose, { subject: string; hi: string; en: string }> = {
    login: {
      subject: `AgroPulse — आपका लॉगिन कोड ${code}`,
      hi: `AgroPulse में लॉगिन करने के लिए यह कोड डालें: ${code}`,
      en: `Enter this code to sign in to AgroPulse: ${code}`,
    },
    email_verify: {
      subject: `AgroPulse — ईमेल सत्यापन कोड ${code}`,
      hi: `अपना ईमेल पता सत्यापित करने के लिए यह कोड डालें: ${code}`,
      en: `Enter this code to verify your email address: ${code}`,
    },
    password_reset: {
      subject: `AgroPulse — पासवर्ड रीसेट कोड ${code}`,
      hi: `नया पासवर्ड सेट करने के लिए यह कोड डालें: ${code}`,
      en: `Enter this code to set a new password: ${code}`,
    },
  };
  const copy = lines[purpose];
  return {
    subject: copy.subject,
    text: [
      copy.hi,
      `यह कोड ${minutes} मिनट में समाप्त हो जाएगा। यदि आपने यह अनुरोध नहीं किया, तो इस ईमेल को अनदेखा करें।`,
      '',
      copy.en,
      `This code expires in ${minutes} minutes. If you did not request it, ignore this email.`,
      '',
      '— AgroPulse',
    ].join('\n'),
  };
}

/**
 * Rate-limit per address, insert a challenge, and send it.
 *
 * The insert happens before the send so a provider outage cannot mint unlimited
 * challenges, and the send is awaited so the caller can decide what a failure
 * means (the OTP routes surface it; registration treats it as non-fatal).
 */
async function issueEmailChallenge(
  email: string,
  purpose: EmailPurpose,
  db: Queryable = getPool(),
): Promise<OtpRequestResult> {
  const normalized = normalizeEmail(email);

  const { rows: recent } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM otp_challenges
      WHERE lower(email) = $1 AND created_at > now() - interval '1 hour'`,
    [normalized],
  );
  if (Number(recent[0]?.count ?? 0) >= env.EMAIL_OTP_MAX_PER_HOUR) {
    throw new AppError('OTP_RATE_LIMITED', 'Too many code requests. Try again later.', 429);
  }

  const code = newCode();
  const expiresAt = new Date(Date.now() + env.EMAIL_OTP_TTL_S * 1000);
  await db.query(
    'INSERT INTO otp_challenges (email, code, purpose, expires_at) VALUES ($1, $2, $3, $4)',
    [normalized, code, purpose, expiresAt],
  );

  const message = composeCodeEmail(code, purpose);
  await sendMail({ to: normalized, subject: message.subject, text: message.text });

  return {
    sent: true,
    expires_in_s: env.EMAIL_OTP_TTL_S,
    ...(isProd ? {} : { dev_code: code }),
  };
}

/** Newest unconsumed-or-not challenge for this address + purpose. */
async function latestChallenge(
  email: string,
  purpose: EmailPurpose,
  db: Queryable = getPool(),
): Promise<OtpRow | undefined> {
  const { rows } = await db.query<OtpRow>(
    `SELECT * FROM otp_challenges
      WHERE lower(email) = $1 AND purpose = $2
      ORDER BY created_at DESC LIMIT 1`,
    [normalizeEmail(email), purpose],
  );
  return rows[0];
}

/* ─── Registration & password login ─────────────────────────────────────────── */

export interface EmailRegisterResult extends AuthResult {
  /** Whether the verification email went out, and its code outside production. */
  verification: { sent: boolean; dev_code?: string };
}

/**
 * Create an email + password account and sign in immediately.
 *
 * The session is issued *before* the address is verified, on purpose: a farmer
 * who just typed a password should land in the app, not in an inbox. Verification
 * is then a nudge (`farmer.email_verified` is false) rather than a gate.
 */
export async function registerWithEmail(input: {
  name: string;
  email: string;
  password: string;
}): Promise<EmailRegisterResult> {
  const passwordHash = await hashPassword(input.password);

  let farmer: FarmerRow;
  try {
    farmer = await createEmailFarmer({
      email: input.email,
      passwordHash,
      name: input.name,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        'EMAIL_TAKEN',
        'An account already exists for this email. Try signing in instead.',
        409,
      );
    }
    throw err;
  }

  const tokens = await withClient((client) => issueTokens(farmer, client));
  logger.info('register_ok', { farmer_id: farmer.id, provider: 'email' });

  // Non-fatal: the account exists and the farmer is signed in. A mail outage
  // should not undo a successful registration — they can request a code later.
  let verification: { sent: boolean; dev_code?: string } = { sent: false };
  try {
    const issued = await issueEmailChallenge(input.email, 'email_verify');
    verification = { sent: true, ...(issued.dev_code ? { dev_code: issued.dev_code } : {}) };
  } catch (err) {
    logger.warn('email_verify_send_failed', { farmer_id: farmer.id, ...describeError(err) });
  }

  return { farmer: toPublicFarmer(farmer), tokens, verification };
}

const BAD_CREDENTIALS = (): AppError =>
  new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);

/** Sign in with email + password. */
export async function loginWithEmail(input: {
  email: string;
  password: string;
}): Promise<AuthResult> {
  const farmer = await findFarmerByEmail(input.email);

  if (!farmer || !farmer.password_hash) {
    // Either the address is unknown, or it belongs to a Google/code-only account
    // with no password. Both answer identically, at the same cost.
    await verifyDummy(input.password);
    throw BAD_CREDENTIALS();
  }

  const ok = await verifyPassword(input.password, farmer.password_hash);
  if (!ok) throw BAD_CREDENTIALS();

  // A raised PASSWORD_SCRYPT_COST only reaches existing accounts here, at the one
  // moment the plaintext is legitimately in hand.
  if (needsRehash(farmer.password_hash)) {
    try {
      await setPasswordHash(farmer.id, await hashPassword(input.password));
    } catch (err) {
      logger.warn('password_rehash_failed', { farmer_id: farmer.id, ...describeError(err) });
    }
  }

  const tokens = await withClient((client) => issueTokens(farmer, client));
  logger.info('login_ok', { farmer_id: farmer.id, role: farmer.role, provider: 'email_password' });
  return { farmer: toPublicFarmer(farmer), tokens };
}

/* ─── Email one-time codes ──────────────────────────────────────────────────── */

/**
 * Send a login or verification code to an email address.
 *
 * For `login` the address need not exist yet — verifying the code creates the
 * account, exactly as the phone flow does, which is what makes email a real
 * passwordless door rather than a password reset in disguise.
 *
 * For `email_verify` an account must already exist; if it does not, this reports
 * success without sending, so the endpoint cannot be used to test whether an
 * address is registered.
 */
export async function requestEmailOtp(
  email: string,
  purpose: 'login' | 'email_verify',
): Promise<OtpRequestResult> {
  if (purpose === 'email_verify') {
    const farmer = await findFarmerByEmail(email);
    if (!farmer) {
      logger.info('email_verify_skipped_unknown_address', {});
      return { sent: true, expires_in_s: env.EMAIL_OTP_TTL_S };
    }
    if (farmer.email_verified_at) {
      throw new AppError('EMAIL_ALREADY_VERIFIED', 'This email is already verified.', 409);
    }
  }
  return issueEmailChallenge(email, purpose);
}

/**
 * Redeem an email code. Both purposes end in a signed-in session:
 *  - `login`         : finds or creates the farmer, marks the email verified
 *                      (they just proved control of it) and issues tokens.
 *  - `email_verify`  : requires the account, stamps verification, re-issues tokens.
 */
export async function verifyEmailOtp(
  email: string,
  code: string,
  purpose: 'login' | 'email_verify',
): Promise<AuthResult> {
  const existing = await findFarmerByEmail(email);
  if (purpose === 'email_verify' && !existing) {
    throw new AppError('OTP_INVALID', 'No active code for this address. Request a new one.', 401);
  }

  const challenge = await redeemChallenge(await latestChallenge(email, purpose), code, {
    missing: 'No active code for this address. Request a new one.',
    expired: 'This code has expired. Request a new one.',
  });

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [
        challenge.id,
      ]);

      let farmer: FarmerRow;
      if (existing) {
        farmer = await markEmailVerified(existing.id, client);
      } else {
        // First sight of this address: a passwordless account, already verified
        // because redeeming the code *is* the proof.
        farmer = await createEmailFarmer(
          { email, passwordHash: null, name: null, emailVerified: true },
          client,
        );
      }

      const tokens = await issueTokens(farmer, client);
      await client.query('COMMIT');
      logger.info('login_ok', { farmer_id: farmer.id, role: farmer.role, provider: 'email_otp' });
      return { farmer: toPublicFarmer(farmer), tokens };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/* ─── Password reset ───────────────────────────────────────────────────────── */

/**
 * Start a password reset. Always reports success — see the enumeration note at
 * the top of this file: an honest "no such account" here would leak the customer
 * list of every address someone cares to try.
 */
export async function forgotPassword(email: string): Promise<OtpRequestResult> {
  const farmer = await findFarmerByEmail(email);
  if (!farmer) {
    logger.info('password_reset_skipped_unknown_address', {});
    return { sent: true, expires_in_s: env.EMAIL_OTP_TTL_S };
  }
  return issueEmailChallenge(email, 'password_reset');
}

/**
 * Finish a password reset: set the new password and sign the farmer in.
 *
 * Every existing refresh token is revoked in the same transaction. That is the
 * whole point of a reset — if the account was compromised, changing the password
 * while leaving the attacker's 30-day refresh token alive would accomplish
 * nothing.
 */
export async function resetPassword(
  email: string,
  code: string,
  password: string,
): Promise<AuthResult> {
  const farmer = await findFarmerByEmail(email);
  if (!farmer) {
    // Mirrors the "no active code" answer so the failure mode is identical to a
    // wrong code, rather than confirming the address is unknown.
    throw new AppError('OTP_INVALID', 'No active code for this address. Request a new one.', 401);
  }

  const challenge = await redeemChallenge(await latestChallenge(email, 'password_reset'), code, {
    missing: 'No active code for this address. Request a new one.',
    expired: 'This code has expired. Request a new one.',
  });

  const passwordHash = await hashPassword(password);

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [
        challenge.id,
      ]);
      await setPasswordHash(farmer.id, passwordHash, client);
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE farmer_id = $1 AND revoked_at IS NULL',
        [farmer.id],
      );
      const fresh = await markEmailVerified(farmer.id, client);
      const tokens = await issueTokens(fresh, client);
      await client.query('COMMIT');
      logger.info('password_reset_ok', { farmer_id: farmer.id });
      return { farmer: toPublicFarmer(fresh), tokens };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}
