import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs } from '../../src/runners/retry-after.js';

describe('parseRetryAfterMs', () => {
  it('reads delay seconds', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('reads HTTP dates as a wait from now', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const wait = parseRetryAfterMs(future);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(30_000);
  });

  it('returns undefined for anything unusable', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
  });
});
