import { describe, expect, it } from 'vitest';
import {
  EmailLoginSchema,
  EmailOtpRequestSchema,
  EmailOtpVerifySchema,
  EmailRegisterSchema,
  GoogleSignInSchema,
  LogoutSchema,
  PasswordResetSchema,
  PasswordSchema,
  PhoneSchema,
} from '../src/modules/auth/auth.dto';
import { UpdateMeSchema } from '../src/modules/farmers/farmers.dto';
import { CreateFeedbackSchema } from '../src/modules/feedback/feedback.dto';
import { CreateReadingSchema } from '../src/modules/readings/readings.dto';
import { CreateRecommendationSchema } from '../src/modules/recommendations/recommendations.dto';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('CreateReadingSchema', () => {
  it('accepts a minimal manual reading and defaults npk_is_calibrated', () => {
    const parsed = CreateReadingSchema.parse({ source: 'manual' });
    expect(parsed.npk_is_calibrated).toBe(false);
  });

  it('mirrors the DB CHECK bounds', () => {
    expect(CreateReadingSchema.safeParse({ source: 'manual', ph: 6.5 }).success).toBe(true);
    expect(CreateReadingSchema.safeParse({ source: 'manual', ph: 15 }).success).toBe(false);
    expect(CreateReadingSchema.safeParse({ source: 'manual', n_mgkg: -5 }).success).toBe(false);
    expect(CreateReadingSchema.safeParse({ source: 'manual', moisture_vwc: 150 }).success).toBe(
      false,
    );
  });

  it('rejects an unknown source', () => {
    expect(CreateReadingSchema.safeParse({ source: 'satellite' }).success).toBe(false);
  });
});

describe('PhoneSchema', () => {
  it('accepts 10–15 digits, optional +', () => {
    expect(PhoneSchema.safeParse('+919876543210').success).toBe(true);
    expect(PhoneSchema.safeParse('9876543210').success).toBe(true);
  });
  it('rejects junk', () => {
    expect(PhoneSchema.safeParse('123').success).toBe(false);
    expect(PhoneSchema.safeParse('not-a-phone').success).toBe(false);
  });
});

describe('CreateRecommendationSchema', () => {
  it('allows an empty body (use latest reading + defaults)', () => {
    expect(CreateRecommendationSchema.safeParse({}).success).toBe(true);
  });
  it('accepts documented overrides', () => {
    expect(
      CreateRecommendationSchema.safeParse({ area_ha: 1.5, season: 'Rabi' }).success,
    ).toBe(true);
  });
  it('is strict: unknown keys are rejected', () => {
    expect(CreateRecommendationSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
  it('rejects a non-positive area', () => {
    expect(CreateRecommendationSchema.safeParse({ area_ha: 0 }).success).toBe(false);
  });
});

describe('CreateFeedbackSchema', () => {
  it('requires at least one substantive field', () => {
    expect(CreateFeedbackSchema.safeParse({ recommendation_id: UUID }).success).toBe(false);
  });
  it('accepts a recommendation_id plus an outcome', () => {
    expect(
      CreateFeedbackSchema.safeParse({ recommendation_id: UUID, outcome: 'good yield' }).success,
    ).toBe(true);
  });
});

/* ─── Email + password auth ─────────────────────────────────────────────────── */

describe('EmailSchema (via EmailOtpRequestSchema)', () => {
  it('canonicalises the address so the unique index sees one form', () => {
    const parsed = EmailOtpRequestSchema.parse({
      email: '  Farmer@Example.COM ',
      purpose: 'login',
    });
    expect(parsed.email).toBe('farmer@example.com');
  });

  it('rejects junk and over-long addresses', () => {
    expect(EmailOtpRequestSchema.safeParse({ email: 'nope', purpose: 'login' }).success).toBe(false);
    const tooLong = `${'a'.repeat(250)}@example.com`;
    expect(EmailOtpRequestSchema.safeParse({ email: tooLong, purpose: 'login' }).success).toBe(
      false,
    );
  });

  it('only allows the two purposes the client can ask for', () => {
    expect(
      EmailOtpRequestSchema.safeParse({ email: 'a@b.com', purpose: 'email_verify' }).success,
    ).toBe(true);
    // password_reset exists in the DB but has its own route, so it must not be
    // reachable through the generic code request.
    expect(
      EmailOtpRequestSchema.safeParse({ email: 'a@b.com', purpose: 'password_reset' }).success,
    ).toBe(false);
  });
});

describe('PasswordSchema', () => {
  it('mirrors the client rule: 8+ characters with a letter and a digit', () => {
    expect(PasswordSchema.safeParse('paddy2024').success).toBe(true);
    expect(PasswordSchema.safeParse('short1').success).toBe(false); // too short
    expect(PasswordSchema.safeParse('allletters').success).toBe(false); // no digit
    expect(PasswordSchema.safeParse('12345678').success).toBe(false); // no letter
  });

  it('caps the length, because the scrypt work is paid on our CPU', () => {
    expect(PasswordSchema.safeParse(`${'a'.repeat(200)}1`).success).toBe(false);
  });
});

describe('EmailRegisterSchema', () => {
  it('accepts a full sign-up and trims the name', () => {
    const parsed = EmailRegisterSchema.parse({
      name: '  Ramesh Kumar ',
      email: 'ramesh@example.com',
      password: 'paddy2024',
    });
    expect(parsed.name).toBe('Ramesh Kumar');
  });

  it('enforces the password policy at sign-up', () => {
    expect(
      EmailRegisterSchema.safeParse({ email: 'a@b.com', password: 'weak' }).success,
    ).toBe(false);
  });
});

describe('EmailLoginSchema', () => {
  it('does NOT apply the password policy', () => {
    // Someone who registered before a policy change must still be able to log in;
    // rejecting their password at the door would lock them out of their account.
    expect(EmailLoginSchema.safeParse({ email: 'a@b.com', password: 'oldpw' }).success).toBe(true);
  });

  it('still requires a non-empty password', () => {
    expect(EmailLoginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
  });
});

describe('code schemas', () => {
  it('requires exactly six digits', () => {
    const base = { email: 'a@b.com', purpose: 'login' as const };
    expect(EmailOtpVerifySchema.safeParse({ ...base, code: '123456' }).success).toBe(true);
    expect(EmailOtpVerifySchema.safeParse({ ...base, code: '12345' }).success).toBe(false);
    expect(EmailOtpVerifySchema.safeParse({ ...base, code: '12345a' }).success).toBe(false);
  });

  it('holds a reset to both a valid code and the password policy', () => {
    expect(
      PasswordResetSchema.safeParse({ email: 'a@b.com', code: '123456', password: 'paddy2024' })
        .success,
    ).toBe(true);
    expect(
      PasswordResetSchema.safeParse({ email: 'a@b.com', code: '123456', password: 'weak' }).success,
    ).toBe(false);
  });
});

describe('GoogleSignInSchema', () => {
  it('checks the JWT shape only — the real check is cryptographic', () => {
    expect(GoogleSignInSchema.safeParse({ id_token: 'aaaa.bbbb.cccc' }).success).toBe(true);
    expect(GoogleSignInSchema.safeParse({ id_token: 'not-a-jwt' }).success).toBe(false);
    expect(GoogleSignInSchema.safeParse({}).success).toBe(false);
  });
});

describe('LogoutSchema', () => {
  it('defaults `all` to false so an ordinary sign-out ends one session', () => {
    expect(LogoutSchema.parse({ refresh_token: 'a'.repeat(20) }).all).toBe(false);
    expect(LogoutSchema.parse({ refresh_token: 'a'.repeat(20), all: true }).all).toBe(true);
  });
});

describe('UpdateMeSchema', () => {
  it('accepts a partial patch', () => {
    expect(UpdateMeSchema.safeParse({ name: 'Ramesh' }).success).toBe(true);
    expect(UpdateMeSchema.safeParse({ preferred_lang: 'hi' }).success).toBe(true);
  });

  it('rejects an empty patch', () => {
    expect(UpdateMeSchema.safeParse({}).success).toBe(false);
  });

  it('refuses to patch identity or privilege fields', () => {
    // Strict object: email, phone, google_sub and role are not patchable at all,
    // so a farmer cannot promote themselves or take over another address.
    expect(UpdateMeSchema.safeParse({ name: 'R', role: 'admin' }).success).toBe(false);
    expect(UpdateMeSchema.safeParse({ email: 'new@example.com' }).success).toBe(false);
    expect(UpdateMeSchema.safeParse({ phone: '+919876543210' }).success).toBe(false);
  });

  it('only allows the two supported languages', () => {
    expect(UpdateMeSchema.safeParse({ preferred_lang: 'fr' }).success).toBe(false);
  });
});
