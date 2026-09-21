import { describe, expect, it } from 'vitest';
import { nextCronRun, parseCron, previewCronRuns } from '../../src/core/cron.js';

const utc = (iso: string): number => new Date(iso).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();

describe('parseCron', () => {
  it('parses names, steps, lists and ranges', () => {
    expect(parseCron('*/15 * * * *').minute).toEqual(new Set([0, 15, 30, 45]));
    expect(parseCron('0 9 * * MON-FRI').dayOfWeek).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(parseCron('0 0 * jan,dec sun').month).toEqual(new Set([1, 12]));
  });

  it('treats 7 as Sunday in day-of-week', () => {
    expect(parseCron('0 0 * * 7').dayOfWeek).toEqual(parseCron('0 0 * * sun').dayOfWeek);
  });

  it('rejects the wrong field count, out-of-range values and backwards ranges', () => {
    expect(() => parseCron('* * * *')).toThrow(/exactly 5 fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/outside 0-59/);
    expect(() => parseCron('* * * * 8')).toThrow(/outside 0-6/);
    expect(() => parseCron('5-2 * * * *')).toThrow(/backwards/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/positive integer/);
    expect(() => parseCron('0 9 * * someday')).toThrow(/outside 0-6/);
  });
});

describe('nextCronRun', () => {
  it('finds the next daily midnight strictly after now', () => {
    expect(iso(nextCronRun(parseCron('0 0 * * *'), utc('2026-06-15T12:00:00.000Z')))).toBe(
      '2026-06-16T00:00:00.000Z'
    );
    // Exactly on the slot still moves forward.
    expect(iso(nextCronRun(parseCron('0 12 * * *'), utc('2026-06-15T12:00:00.000Z')))).toBe(
      '2026-06-16T12:00:00.000Z'
    );
  });

  it('handles intra-day steps', () => {
    expect(iso(nextCronRun(parseCron('*/30 9 * * *'), utc('2026-06-15T09:10:00.000Z')))).toBe(
      '2026-06-15T09:30:00.000Z'
    );
  });

  it('matches weekday names across the week boundary', () => {
    // 2026-06-14 is a Sunday.
    expect(iso(nextCronRun(parseCron('0 9 * * mon'), utc('2026-06-14T10:00:00.000Z')))).toBe(
      '2026-06-15T09:00:00.000Z'
    );
  });

  it('takes either side of a restricted day-of-month/day-of-week pair', () => {
    // Sunday the 14th: not the 1st, so the next match is Sunday the 21st, ahead of July 1st.
    expect(iso(nextCronRun(parseCron('0 0 1 * sun'), utc('2026-06-14T00:00:01.000Z')))).toBe(
      '2026-06-21T00:00:00.000Z'
    );
  });

  it('fails closed on a date that never exists', () => {
    expect(() => nextCronRun(parseCron('0 0 30 2 *'), utc('2026-01-01T00:00:00.000Z'))).toThrow(/never matches/);
  });

  it('matches wall-clock time in a named zone across DST', () => {
    // America/New_York is UTC-5 in January, UTC-4 in July.
    expect(iso(nextCronRun(parseCron('0 9 * * *'), utc('2026-01-15T12:00:00.000Z'), 'America/New_York'))).toBe(
      '2026-01-15T14:00:00.000Z'
    );
    expect(iso(nextCronRun(parseCron('0 9 * * *'), utc('2026-07-15T12:00:00.000Z'), 'America/New_York'))).toBe(
      '2026-07-15T13:00:00.000Z'
    );
  });

  it('skips a wall-clock time destroyed by spring-forward', () => {
    // 2026-03-08 02:30 never happens in America/New_York: clocks jump 2:00 to 3:00.
    expect(iso(nextCronRun(parseCron('30 2 * * *'), utc('2026-03-08T00:00:00.000Z'), 'America/New_York'))).toBe(
      '2026-03-09T06:30:00.000Z'
    );
  });

  it('rejects an unknown timezone without scanning', () => {
    expect(() => nextCronRun(parseCron('* * * * *'), utc('2026-01-01T00:00:00.000Z'), 'Mars/Olympus')).toThrow(
      /Unknown timezone/
    );
  });

  it('previews the next fire times strictly increasing', () => {
    expect(
      previewCronRuns('0 0 * * *', { count: 3, fromMs: utc('2026-06-15T12:00:00.000Z') })
    ).toEqual(['2026-06-16T00:00:00.000Z', '2026-06-17T00:00:00.000Z', '2026-06-18T00:00:00.000Z']);
    expect(previewCronRuns('0 9 * * *', { count: 2, fromMs: utc('2026-01-15T12:00:00.000Z'), timezone: 'America/New_York' })).toEqual([
      '2026-01-15T14:00:00.000Z',
      '2026-01-16T14:00:00.000Z'
    ]);
  });
});
