import { describe, expect, it } from 'vitest';

import {
  addMonths,
  applyDuration,
  daysUntil,
  formatDate,
  parseDuration,
  parseInstant,
  toIso,
} from '../../src/domain/time.js';
import { withTimeZone } from '../helpers/timezone.js';

/** Local civil date as `YYYY-MM-DD`, which is what the user actually reads. */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe('calendar arithmetic (ADR-006)', () => {
  describe('addMonths clamps day-of-month', () => {
    const cases: Array<[string, number, string, string]> = [
      ['Jan 31 + 3m lands on Apr 30, not May 1', 3, '2026-01-31T09:00:00', '2026-04-30'],
      [
        'Jan 30 + 1m lands on Feb 28 in a common year',
        1,
        '2026-01-30T09:00:00',
        '2026-02-28',
      ],
      [
        'Nov 30 + 3m lands on Feb 28 in a common year',
        3,
        '2025-11-30T09:00:00',
        '2026-02-28',
      ],
      [
        'Nov 30 + 3m lands on Feb 29 in a leap year',
        3,
        '2023-11-30T09:00:00',
        '2024-02-29',
      ],
      [
        'Nov 29 + 3m lands on Feb 29 in a leap year',
        3,
        '2023-11-29T09:00:00',
        '2024-02-29',
      ],
      ['Dec 31 + 3m crosses the year boundary', 3, '2026-12-31T09:00:00', '2027-03-31'],
      ['Aug 17 + 3m is an ordinary case', 3, '2026-08-17T09:00:00', '2026-11-17'],
      ['Feb 29 + 12m clamps to Feb 28', 12, '2024-02-29T09:00:00', '2025-02-28'],
    ];

    for (const [name, months, from, expected] of cases) {
      it(name, () => {
        withTimeZone('UTC', () => {
          expect(localDate(addMonths(new Date(from), months))).toBe(expected);
        });
      });
    }

    it('is not 90 days — the two disagree across short months', () => {
      withTimeZone('UTC', () => {
        const from = new Date('2026-01-31T09:00:00');
        const threeMonths = addMonths(from, 3);
        const ninetyDays = new Date(from.getTime() + 90 * 86_400_000);
        expect(localDate(threeMonths)).toBe('2026-04-30');
        expect(localDate(ninetyDays)).toBe('2026-05-01');
      });
    });
  });

  describe('DST', () => {
    it('keeps local wall-clock time across a spring-forward', () => {
      // US DST begins 2026-03-08. A hold set the day before must not come back
      // an hour — and therefore possibly a day — early.
      withTimeZone('America/New_York', () => {
        const from = new Date('2026-03-07T23:30:00');
        const until = addMonths(from, 3);
        expect(localDate(until)).toBe('2026-06-07');
        expect(until.getHours()).toBe(23);
        expect(until.getMinutes()).toBe(30);
      });
    });

    it('keeps local wall-clock time across a fall-back', () => {
      withTimeZone('America/New_York', () => {
        const from = new Date('2026-09-01T00:30:00');
        const until = addMonths(from, 3);
        expect(localDate(until)).toBe('2026-12-01');
        expect(until.getHours()).toBe(0);
        expect(until.getMinutes()).toBe(30);
      });
    });

    it('adds a real calendar month in a southern-hemisphere DST zone', () => {
      withTimeZone('Australia/Sydney', () => {
        const from = new Date('2026-09-30T22:00:00');
        expect(localDate(addMonths(from, 3))).toBe('2026-12-30');
      });
    });
  });

  describe('daysUntil counts calendar days, not elapsed hours', () => {
    it('reports 1 across a 23-hour spring-forward day', () => {
      withTimeZone('America/New_York', () => {
        const from = new Date('2026-03-07T12:00:00');
        const to = new Date('2026-03-08T12:00:00');
        // Only 23 hours elapse; the user still slept once.
        expect(to.getTime() - from.getTime()).toBe(23 * 3_600_000);
        expect(daysUntil(from, to)).toBe(1);
      });
    });

    it('reports 1 across a 25-hour fall-back day', () => {
      withTimeZone('America/New_York', () => {
        const from = new Date('2026-11-01T00:30:00');
        const to = new Date('2026-11-02T00:30:00');
        expect(to.getTime() - from.getTime()).toBe(25 * 3_600_000);
        expect(daysUntil(from, to)).toBe(1);
      });
    });

    it('reports 0 for two moments on the same day', () => {
      withTimeZone('UTC', () => {
        expect(
          daysUntil(new Date('2026-08-17T01:00:00'), new Date('2026-08-17T23:00:00')),
        ).toBe(0);
      });
    });

    it('counts a full three-month hold', () => {
      withTimeZone('UTC', () => {
        const from = new Date('2026-08-17T09:00:00');
        expect(daysUntil(from, addMonths(from, 3))).toBe(92);
      });
    });
  });

  describe('parseDuration', () => {
    it.each([
      ['3m', { months: 3 }],
      ['6M', { months: 6 }],
      ['6 months', { months: 6 }],
      ['1mo', { months: 1 }],
      ['45d', { days: 45 }],
      ['10 days', { days: 10 }],
      ['1y', { months: 12 }],
      ['2 years', { months: 24 }],
    ] as const)('reads %s', (input, expected) => {
      expect(parseDuration(input)).toEqual(expected);
    });

    it.each(['forever', 'FOREVER', ' never '])('reads %s as forever', (input) => {
      expect(parseDuration(input)).toBe('forever');
    });

    it.each(['', 'soon', '3 fortnights', '-2m', '0m', '3'])('rejects %s', (input) => {
      expect(() => parseDuration(input)).toThrow(RangeError);
    });
  });

  describe('applyDuration', () => {
    it('returns null for forever, which ADR-006 defines as never resurface', () => {
      expect(applyDuration(new Date('2026-08-17T00:00:00Z'), 'forever')).toBeNull();
    });

    it('adds whole days for a day duration', () => {
      withTimeZone('UTC', () => {
        const result = applyDuration(new Date('2026-08-17T09:00:00'), { days: 45 });
        expect(localDate(result as Date)).toBe('2026-10-01');
      });
    });

    it('adds calendar months for a month duration', () => {
      withTimeZone('UTC', () => {
        const result = applyDuration(new Date('2026-01-31T09:00:00'), { months: 3 });
        expect(localDate(result as Date)).toBe('2026-04-30');
      });
    });
  });

  describe('serialisation', () => {
    it('round-trips through UTC ISO-8601', () => {
      const iso = '2026-08-17T09:30:00.000Z';
      expect(toIso(parseInstant(iso))).toBe(iso);
    });

    it('stores UTC even when the local clock is elsewhere', () => {
      withTimeZone('America/New_York', () => {
        expect(toIso(new Date('2026-08-17T09:00:00'))).toBe('2026-08-17T13:00:00.000Z');
      });
    });

    it('rejects an unparseable instant rather than silently yielding NaN', () => {
      expect(() => parseInstant('not a date')).toThrow(RangeError);
    });
  });

  describe('formatDate renders the local calendar date', () => {
    it('formats as the legibility requirements quote it', () => {
      withTimeZone('UTC', () => {
        expect(formatDate(new Date('2026-10-03T12:00:00'))).toBe('Oct 3, 2026');
        expect(formatDate(new Date('2026-11-17T12:00:00'))).toBe('Nov 17, 2026');
      });
    });

    it('renders the user local date, not the UTC one', () => {
      // 2026-11-18T02:00Z is still Nov 17 in New York. The user was promised
      // "until Nov 17", so that is what has to be printed.
      withTimeZone('America/New_York', () => {
        expect(formatDate(new Date('2026-11-18T02:00:00Z'))).toBe('Nov 17, 2026');
      });
    });
  });
});
