import { withClient, type Queryable } from '../../common/db';
import { AppError } from '../../common/errors';
import { verifyGoogleIdToken, type GoogleIdentity } from '../../common/google-oauth';
import { logger } from '../../common/logger';
import {
  backfillFarmerName,
  createGoogleFarmer,
  findFarmerByEmail,
  findFarmerByGoogleSub,
  isUniqueViolation,
  linkGoogleSub,
  markEmailVerified,
  toPublicFarmer,
  type FarmerRow,
} from '../farmers/farmers.repo';
import { issueTokens, type AuthResult } from './auth.service';

/**
 * "Continue with Google" (POST /v1/auth/google).
 *
 * The client sends the ID token the native Google SDK produced;
 * `common/google-oauth.ts` proves it is genuine, and this service maps the proven
 * identity onto a farmer row.
 *
 * ── Resolution order, and why it is this order ────────────────────────────────
 *
 * 1. **By `google_sub`.** Google's subject claim is immutable; the email on a
 *    Google account is not. Matching on sub first means a farmer who changes their
 *    Gmail address keeps their fields and history.
 *
 * 2. **By verified email → link.** Someone who registered with email + password
 *    and later taps "Continue with Google" is the same person; linking `google_sub`
 *    onto their existing row keeps them in one account instead of quietly starting
 *    a second, empty one.
 *
 *    This step runs **only when Google says `email_verified` is true.** That
 *    condition is the security hinge of the whole flow: Google Workspace accounts
 *    can carry an email the domain admin never proved, so linking on an unverified
 *    address would let anyone who can mint such a token take over an existing
 *    AgroPulse account by claiming its email. Unverified addresses therefore fall
 *    through to step 3 and get their own separate account.
 *
 * 3. **Create.** A fresh Google-only farmer: no phone, no password.
 */

async function resolveFarmer(identity: GoogleIdentity, db: Queryable): Promise<FarmerRow> {
  const bySub = await findFarmerByGoogleSub(identity.sub, db);
  if (bySub) {
    // Keep the row in step with the Google profile without ever overwriting
    // something the farmer set themselves.
    let farmer = bySub;
    if (identity.name && !farmer.name) {
      farmer = await backfillFarmerName(farmer.id, identity.name, db);
    }
    if (identity.emailVerified && !farmer.email_verified_at && farmer.email) {
      farmer = await markEmailVerified(farmer.id, db);
    }
    return farmer;
  }

  if (identity.email && identity.emailVerified) {
    const byEmail = await findFarmerByEmail(identity.email, db);
    if (byEmail) {
      if (byEmail.google_sub && byEmail.google_sub !== identity.sub) {
        // Two different Google accounts claiming one address. Refuse rather than
        // steal the link — this should be impossible, so surface it loudly.
        logger.warn('google_sub_conflict', { farmer_id: byEmail.id });
        throw new AppError(
          'ACCOUNT_CONFLICT',
          'This email is already linked to a different Google account.',
          409,
        );
      }
      const linked = await linkGoogleSub(
        byEmail.id,
        { googleSub: identity.sub, emailVerified: identity.emailVerified },
        db,
      );
      logger.info('google_account_linked', { farmer_id: linked.id });
      return identity.name && !linked.name
        ? await backfillFarmerName(linked.id, identity.name, db)
        : linked;
    }
  }

  try {
    return await createGoogleFarmer(
      {
        googleSub: identity.sub,
        // An unverified Google email is not stored as this account's email: it
        // would occupy the unique address that its real owner may later register.
        email: identity.emailVerified ? identity.email : null,
        name: identity.name,
        emailVerified: identity.emailVerified,
      },
      db,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Two taps racing each other: the other one won, so adopt its row.
      const raced = await findFarmerByGoogleSub(identity.sub, db);
      if (raced) return raced;
    }
    throw err;
  }
}

/** Verify a Google ID token and return a signed-in session. */
export async function signInWithGoogle(idToken: string): Promise<AuthResult> {
  const identity = await verifyGoogleIdToken(idToken);

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const farmer = await resolveFarmer(identity, client);
      const tokens = await issueTokens(farmer, client);
      await client.query('COMMIT');
      logger.info('login_ok', { farmer_id: farmer.id, role: farmer.role, provider: 'google' });
      return { farmer: toPublicFarmer(farmer), tokens };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}
