import { OrchestratorError } from '../errors.js';

/**
 * Minimal five-field cron (`minute hour day-of-month month day-of-week`,
 * UTC): `*`, `*\/n`, `a`, `a,b`, `a-b`, `a-b/n`, with `jan`-`dec` and
 * `sun`-`sat` names. Deliberately no seconds, no `L`/`W`/`#`, no timezones —
 * a schedule that needs those can live in the system cron that calls back
 * into job_submit instead. Everything is validated up front so a bad
 * expression fails at schedule_create, never silently never-fires.
 */
export type CronSchedule = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
};

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 }
] as const;

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

function parseValue(raw: string, min: number, max: number, names: Record<string, number>): number {
  const lowered = raw.toLowerCase();
  if (lowered in names) return names[lowered] as number;
  // `7` means Sunday in day-of-week, everywhere else it is out of range.
  if (lowered === '7' && min === 0 && max === 6) return 0;
  const value = Number(lowered);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new OrchestratorError(
      'INVALID_INPUT',
      `Cron value "${raw}" is outside ${min}-${max}.`,
      'Use numbers in range, *, */n, a-b or comma lists.'
    );
  }
  return value;
}

function parseField(raw: string, min: number, max: number, names: Record<string, number>): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new OrchestratorError('INVALID_INPUT', `Cron step "${part}" must be a positive integer.`);
    }
    let from: number;
    let to: number;
    if (range === '' || range === undefined) {
      throw new OrchestratorError('INVALID_INPUT', `Cron part "${part}" is empty.`);
    } else if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [lo, hi] = range.split('-');
      if (lo === undefined || hi === undefined || lo === '' || hi === '') {
        throw new OrchestratorError('INVALID_INPUT', `Cron range "${part}" needs both ends.`);
      }
      from = parseValue(lo, min, max, names);
      to = parseValue(hi, min, max, names);
      if (from > to) {
        throw new OrchestratorError('INVALID_INPUT', `Cron range "${part}" runs backwards.`);
      }
    } else {
      from = parseValue(range, min, max, names);
      to = stepRaw === undefined ? from : max;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  if (values.size === 0) {
    throw new OrchestratorError('INVALID_INPUT', 'Cron field matched no values.');
  }
  return values;
}

export function parseCron(raw: string): CronSchedule {
  const fields = raw.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new OrchestratorError(
      'INVALID_INPUT',
      `Cron expression needs exactly 5 fields, got ${fields.length}: "${raw}".`,
      'Shape: "minute hour day-of-month month day-of-week", e.g. "0 9 * * mon-fri".'
    );
  }
  const nameTables: Record<string, number>[] = [{}, {}, {}, MONTH_NAMES, DOW_NAMES];
  const [minute, hour, dayOfMonth, month, dayOfWeek] = FIELD_RANGES.map((field, index) =>
    parseField(
      fields[index] === undefined ? '' : (fields[index] as string),
      field.min,
      field.max,
      nameTables[index] === undefined ? {} : (nameTables[index] as Record<string, number>)
    )
  );
  return {
    minute: minute as Set<number>,
    hour: hour as Set<number>,
    dayOfMonth: dayOfMonth as Set<number>,
    month: month as Set<number>,
    dayOfWeek: dayOfWeek as Set<number>
  };
}

export type WallClock = {
  year: number;
  minute: number;
  hour: number;
  day: number;
  month: number;
  dayOfWeek: number;
};

/** Standard day-of-month/day-of-week OR: both restricted → either may match; one `*` → the other governs. */
function matchesFields(
  cron: CronSchedule,
  wall: WallClock,
  domRestricted: boolean,
  dowRestricted: boolean
): boolean {
  if (!cron.minute.has(wall.minute)) return false;
  if (!cron.hour.has(wall.hour)) return false;
  if (!cron.month.has(wall.month)) return false;
  return (
    (!domRestricted && !dowRestricted) ||
    (domRestricted && cron.dayOfMonth.has(wall.day)) ||
    (dowRestricted && cron.dayOfWeek.has(wall.dayOfWeek))
  );
}

/** Minutes since the epoch for the wall clock the zone shows at an instant. */
function wallParts(timeZone: string, timestampMs: number): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric'
  }).formatToParts(new Date(timestampMs));
  const get = (type: string): number => {
    const part = parts.find(candidate => candidate.type === type);
    if (part === undefined) throw new Error(`unreachable: no ${type} part`);
    return Number(part.value);
  };
  // h23 midnight still renders as 24 on some implementations.
  const hour = get('hour') === 24 ? 0 : get('hour');
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    minute: get('minute'),
    hour,
    day,
    month,
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  };
}

/** Zone offset in milliseconds at an instant, from the wall clock itself. No tables, DST included. */
function zoneOffsetMs(timeZone: string, timestampMs: number): number {
  const truncated = Math.floor(timestampMs / 60_000) * 60_000;
  const wall = wallParts(timeZone, truncated);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - truncated;
}

/**
 * The next minute strictly after `fromMs` matching the schedule. Without a
 * timezone that is UTC; with one, the fields match wall-clock time in the
 * zone (an IANA name like "Europe/Berlin", validated up front). Scans forward
 * at most a leap year — anything valid matches long before that, so running
 * out means the expression can never fire (e.g. Feb 30) and that is an error,
 * not null.
 */
export function nextCronRun(cron: CronSchedule, fromMs: number, timeZone?: string): number {
  if (timeZone === undefined) return scanUtc(cron, fromMs);

  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new OrchestratorError(
      'INVALID_INPUT',
      `Unknown timezone "${timeZone}".`,
      'Use an IANA name like "Europe/Berlin".'
    );
  }

  // Search in wall-clock space, where the fields live, then shift back: the
  // offset is recomputed at the candidate because DST may change between now
  // and then. The verify pass is what makes a nonexistent spring-forward
  // time skip instead of landing wrong — it renders the candidate back and
  // requires every field to actually match.
  let wallCursor = fromMs + zoneOffsetMs(timeZone, fromMs);
  for (let round = 0; round < 10; round++) {
    const wallMatch = scanUtc(cron, wallCursor);
    const utc = wallMatch - zoneOffsetMs(timeZone, wallMatch);
    if (matchesWall(cron, timeZone, utc)) return utc;
    wallCursor = wallMatch + 60_000;
  }

  throw new OrchestratorError(
    'INVALID_INPUT',
    'Cron expression never matches a real date in this timezone.',
    'Pick a combination that exists.'
  );
}

function scanUtc(cron: CronSchedule, fromMs: number): number {
  const domRestricted = cron.dayOfMonth.size < 31;
  const dowRestricted = cron.dayOfWeek.size < 7;

  let cursor = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const limit = cursor + 366 * 24 * 60 * 60_000;
  for (; cursor <= limit; cursor += 60_000) {
    const date = new Date(cursor);
    if (
      matchesFields(
        cron,
        {
          year: date.getUTCFullYear(),
          minute: date.getUTCMinutes(),
          hour: date.getUTCHours(),
          day: date.getUTCDate(),
          month: date.getUTCMonth() + 1,
          dayOfWeek: date.getUTCDay()
        },
        domRestricted,
        dowRestricted
      )
    ) {
      return cursor;
    }
  }

  throw new OrchestratorError(
    'INVALID_INPUT',
    'Cron expression never matches a real date (e.g. February 30).',
    'Pick a day that exists.'
  );
}

function matchesWall(cron: CronSchedule, timeZone: string, timestampMs: number): boolean {
  const wall = wallParts(timeZone, timestampMs);
  return matchesFields(
    cron,
    wall,
    cron.dayOfMonth.size < 31,
    cron.dayOfWeek.size < 7
  );
}

/**
 * The next `count` fire times as ISO instants, each strictly after the last.
 * Pure computation — backing the preview tool, so a cron expression (or a
 * schedule edit) can be checked without storing anything.
 */
export function previewCronRuns(
  raw: string,
  options: { timezone?: string; count?: number; fromMs?: number } = {}
): string[] {
  const count = Math.min(Math.max(options.count ?? 5, 1), 20);
  const parsed = parseCron(raw);
  const times: string[] = [];
  let from = options.fromMs ?? Date.now();
  for (let i = 0; i < count; i++) {
    const next = nextCronRun(parsed, from, options.timezone);
    times.push(new Date(next).toISOString());
    from = next;
  }
  return times;
}
