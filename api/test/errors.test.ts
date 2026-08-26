import { describe, expect, it } from 'vitest';
import { AppError, describeError } from '../src/common/errors';

describe('describeError', () => {
  it('never returns an empty message for an AggregateError', () => {
    // The real case this exists for: Node's dual-stack connect fails on every
    // address and throws an AggregateError whose own `message` is ''. This is
    // what a stopped database looked like on Windows, and it logged nothing.
    const err = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:5433'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' }),
    ]);

    expect(err.message).toBe(''); // guards the assumption this test is built on

    const fields = describeError(err);
    expect(fields.message).not.toBe('');
    expect(fields.message).toContain('ECONNREFUSED ::1:5433');
    expect(fields.message).toContain('ECONNREFUSED 127.0.0.1:5433');
    expect(fields.causes).toHaveLength(2);
  });

  it('surfaces the errno code as a separate field', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), {
      code: 'ECONNREFUSED',
    });

    expect(describeError(err)).toEqual({
      message: 'connect ECONNREFUSED 127.0.0.1:5433',
      error_code: 'ECONNREFUSED',
    });
  });

  it('unwraps the cause that fetch hides behind "fetch failed"', () => {
    // undici rejects with a flat "fetch failed" and puts the reason in `cause`,
    // so `ai_service: "down"` used to come with no explanation of why.
    const err = new Error('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), {
        code: 'ECONNREFUSED',
      }),
    });

    const fields = describeError(err);
    expect(fields.message).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:8000');
    expect(fields.error_code).toBe('ECONNREFUSED');
  });

  it('falls back to the class name when an Error has no message', () => {
    expect(describeError(new AppError('X', '')).message).toBe('AppError');
    expect(describeError(new Error()).message).toBe('Error');
  });

  it('handles values that are not Errors at all', () => {
    expect(describeError('boom').message).toBe('boom');
    expect(describeError(undefined).message).toBe('undefined');
    expect(describeError({ nope: true }).message).toBe('[object Object]');
  });

  it('omits optional fields rather than emitting undefined', () => {
    // Keeps log lines clean: no `"error_code":undefined` noise.
    expect(Object.keys(describeError(new Error('plain')))).toEqual(['message']);
  });
});
