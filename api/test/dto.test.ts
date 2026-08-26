import { describe, expect, it } from 'vitest';
import { PhoneSchema } from '../src/modules/auth/auth.dto';
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
