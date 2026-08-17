/**
 * Calendar arithmetic for suppression windows (ADR-006).
 *
 * Two rules govern everything here:
 *
 *   1. **Real calendar months, not `+ 90 days`.** Adding 90 days to a January
 *      date lands in a different place than adding 90 days to a March date, and
 *      the user was promised "three months". Day-of-month is clamped, so
 *      Jan 31 + 3 months is Apr 30.
 *
 *   2. **Instants are stored in UTC; the calendar is the user's local one.**
 *      A hold that expires "on Nov 17" has to expire on the user's Nov 17, not
 *      on UTC's. So the month is added to the *local* civil date and the result
 *      converted back to UTC for storage. Keeping the local wall-clock time is
 *      also what makes a hold crossing a DST boundary land on the right day
 *      rather than an hour — and therefore possibly a day — early.
 */

/** Parse a stored UTC ISO-8601 string, rejecting anything unusable. */
export function parseInstant(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Not a valid ISO-8601 instant: ${JSON.stringify(iso)}`);
  }
  return d;
}

/** Canonical storage form: UTC, ISO-8601, millisecond precision. */
export function toIso(instant: Date): string {
  return instant.toISOString();
}

/**
 * Add whole calendar months in the *local* timezone, clamping day-of-month.
 *
 *   2026-01-31 + 3 months → 2026-04-30  (April has no 31st)
 *   2025-11-30 + 3 months → 2026-02-28  (2026 is not a leap year)
 *   2023-11-30 + 3 months → 2024-02-29  (2024 is)
 */
export function addMonths(instant: Date, months: number): Date {
  const year = instant.getFullYear();
  const month = instant.getMonth();
  const day = instant.getDate();

  const targetMonth = month + months;
  // Day 0 of the following month is the last day of the target month. This
  // also normalises a targetMonth that has run past December or before January.
  const lastDayOfTarget = new Date(year, targetMonth + 1, 0).getDate();

  return new Date(
    year,
    targetMonth,
    Math.min(day, lastDayOfTarget),
    instant.getHours(),
    instant.getMinutes(),
    instant.getSeconds(),
    instant.getMilliseconds(),
  );
}

/**
 * A suppression window, as the user expresses it: `3m`, `6m`, `30d`, `1y`, or
 * `forever`.
 */
export type Duration = { months: number } | { days: number } | 'forever';

const DURATION_PATTERN = /^(\d+)\s*(d|day|days|m|mo|month|months|y|year|years)$/i;

export function parseDuration(input: string): Duration {
  const text = input.trim().toLowerCase();
  if (text === 'forever' || text === 'never') return 'forever';

  const match = DURATION_PATTERN.exec(text);
  if (match === null) {
    throw new RangeError(
      `Cannot read "${input}" as a duration. Use forms like 3m, 6m, 45d, 1y, or forever.`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] as string;
  if (amount <= 0) {
    throw new RangeError(`A suppression window must be positive, got "${input}".`);
  }
  if (unit.startsWith('d')) return { days: amount };
  if (unit.startsWith('y')) return { months: amount * 12 };
  return { months: amount };
}

/**
 * Apply a duration to an instant. `forever` yields `null`, which ADR-006
 * defines as "never resurface".
 */
export function applyDuration(from: Date, duration: Duration): Date | null {
  if (duration === 'forever') return null;
  if ('months' in duration) return addMonths(from, duration.months);
  return new Date(from.getTime() + duration.days * 86_400_000);
}

/**
 * Whole days from `from` until `until`, counted on the local calendar.
 *
 * This is a *date* difference, not a duration divided by 86 400 000 — the user
 * reads "Returns in 47 days" as "47 more sleeps", and across a DST boundary one
 * of those days is 23 or 25 hours long. Dividing elapsed milliseconds would
 * report 46 or 48.
 */
export function daysUntil(from: Date, until: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(until.getFullYear(), until.getMonth(), until.getDate());
  return Math.round((b - a) / 86_400_000);
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * `Oct 3, 2026`, in the user's local timezone.
 *
 * Deliberately hand-rolled rather than `toLocaleDateString`: the legibility
 * requirements in ADR-006 quote exact strings, and ICU output varies by Node
 * build and locale. A tool used twice a year should render the same sentence
 * every time.
 */
export function formatDate(instant: Date): string {
  const month = MONTHS[instant.getMonth()];
  return `${month} ${instant.getDate()}, ${instant.getFullYear()}`;
}
