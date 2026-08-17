import { describe, expect, it } from 'vitest';

import { TestClock } from '../../src/domain/clock.js';
import {
  buildKeepDecision,
  buildUnsubscribeDecision,
  buildUnsuppressDecision,
  hiddenFooter,
  isHiddenByKeep,
  isReviewable,
  keepConfirmation,
  latestDecision,
  returnDescription,
  returningTag,
  suppressionStatus,
  type DecisionRecord,
} from '../../src/domain/decisions.js';
import { withTimeZone } from '../helpers/timezone.js';

let nextId = 1;
function record(partial: Omit<DecisionRecord, 'id'>): DecisionRecord {
  return { id: nextId++, ...partial };
}

describe('decision log (ADR-006)', () => {
  describe('building decisions', () => {
    it('defaults a keep to a three-month calendar hold', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-08-17T09:00:00Z');
        const decision = buildKeepDecision({ senderId: 's1' }, clock);
        expect(decision.decision).toBe('keep');
        expect(decision.decidedAt).toBe('2026-08-17T09:00:00.000Z');
        expect(decision.suppressedUntil).toBe('2026-11-17T09:00:00.000Z');
      });
    });

    it('clamps a keep made on Jan 31', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-01-31T09:00:00Z');
        const decision = buildKeepDecision({ senderId: 's1' }, clock);
        expect(decision.suppressedUntil).toBe('2026-04-30T09:00:00.000Z');
      });
    });

    it('honours a longer window', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-08-17T09:00:00Z');
        const decision = buildKeepDecision(
          { senderId: 's1', duration: { months: 6 } },
          clock,
        );
        expect(decision.suppressedUntil).toBe('2027-02-17T09:00:00.000Z');
      });
    });

    it('records forever as a null suppressed_until', () => {
      const clock = new TestClock('2026-08-17T09:00:00Z');
      const decision = buildKeepDecision({ senderId: 's1', duration: 'forever' }, clock);
      expect(decision.suppressedUntil).toBeNull();
    });

    it('carries a note through', () => {
      const clock = new TestClock('2026-08-17T09:00:00Z');
      expect(
        buildKeepDecision({ senderId: 's1', note: 'actually useful' }, clock).note,
      ).toBe('actually useful');
    });

    it('builds unsubscribe and unsuppress decisions with the clock time', () => {
      const clock = new TestClock('2026-08-17T09:00:00Z');
      expect(buildUnsubscribeDecision('s1', clock)).toMatchObject({
        decision: 'unsubscribe',
        decidedAt: '2026-08-17T09:00:00.000Z',
        suppressedUntil: null,
      });
      expect(buildUnsuppressDecision('s1', clock, 'changed my mind')).toMatchObject({
        decision: 'unsuppress',
        note: 'changed my mind',
      });
    });
  });

  describe('latestDecision', () => {
    it('returns undefined for a sender with no history', () => {
      expect(latestDecision([])).toBeUndefined();
    });

    it('picks the newest by decided_at regardless of array order', () => {
      const older = record({
        senderId: 's1',
        decision: 'keep',
        decidedAt: '2026-01-01T00:00:00.000Z',
        suppressedUntil: '2026-04-01T00:00:00.000Z',
      });
      const newer = record({
        senderId: 's1',
        decision: 'unsuppress',
        decidedAt: '2026-02-01T00:00:00.000Z',
        suppressedUntil: null,
      });
      expect(latestDecision([newer, older])?.decision).toBe('unsuppress');
      expect(latestDecision([older, newer])?.decision).toBe('unsuppress');
    });

    it('breaks a timestamp tie with the higher id', () => {
      const first = record({
        senderId: 's1',
        decision: 'keep',
        decidedAt: '2026-01-01T00:00:00.000Z',
        suppressedUntil: '2026-04-01T00:00:00.000Z',
      });
      const second = record({
        senderId: 's1',
        decision: 'unsuppress',
        decidedAt: '2026-01-01T00:00:00.000Z',
        suppressedUntil: null,
      });
      expect(latestDecision([second, first])?.id).toBe(second.id);
    });
  });

  describe('suppression is projected from the log, not stored', () => {
    it('reports never_decided with no history', () => {
      const clock = new TestClock('2026-08-17T00:00:00Z');
      expect(suppressionStatus([], clock).state).toBe('never_decided');
    });

    it('hides a kept sender for the whole hold and returns it after', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-08-17T09:00:00Z');
        const keep = record({ ...buildKeepDecision({ senderId: 's1' }, clock) });
        const log = [keep];

        // Day of the decision.
        let status = suppressionStatus(log, clock);
        expect(status.state).toBe('suppressed');
        expect(isReviewable(status)).toBe(false);
        expect(isHiddenByKeep(status)).toBe(true);

        // One minute before expiry — still held.
        clock.set('2026-11-17T08:59:00Z');
        expect(suppressionStatus(log, clock).state).toBe('suppressed');

        // One minute after — back on the list.
        clock.set('2026-11-17T09:01:00Z');
        status = suppressionStatus(log, clock);
        expect(status.state).toBe('returning');
        expect(isReviewable(status)).toBe(true);
        expect(isHiddenByKeep(status)).toBe(false);
      });
    });

    it('does not resurface a day early across a DST transition', () => {
      // Kept the evening before US spring-forward. A naive +90 days, or an
      // hour of drift, brings this back on the wrong local day.
      withTimeZone('America/New_York', () => {
        const clock = new TestClock(new Date('2026-03-07T23:30:00'));
        const keep = record({ ...buildKeepDecision({ senderId: 's1' }, clock) });

        // The hold should run to Jun 7 local, 23:30.
        clock.set(new Date('2026-06-07T23:00:00'));
        expect(suppressionStatus([keep], clock).state).toBe('suppressed');

        clock.set(new Date('2026-06-07T23:31:00'));
        expect(suppressionStatus([keep], clock).state).toBe('returning');
      });
    });

    it('counts down in whole calendar days', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-08-17T09:00:00Z');
        const keep = record({ ...buildKeepDecision({ senderId: 's1' }, clock) });

        clock.set('2026-10-01T09:00:00Z');
        const status = suppressionStatus([keep], clock);
        expect(status.state).toBe('suppressed');
        if (status.state !== 'suppressed') throw new Error('unreachable');
        expect(status.daysRemaining).toBe(47);
        expect(returnDescription(status)).toBe('Returns in 47 days (Nov 17, 2026)');
      });
    });

    it('never returns a forever keep', () => {
      const clock = new TestClock('2026-08-17T09:00:00Z');
      const keep = record({
        ...buildKeepDecision({ senderId: 's1', duration: 'forever' }, clock),
      });
      clock.set('2099-01-01T00:00:00Z');
      const status = suppressionStatus([keep], clock);
      expect(status.state).toBe('suppressed_forever');
      expect(isReviewable(status)).toBe(false);
      expect(isHiddenByKeep(status)).toBe(true);
      expect(returnDescription(status)).toBe('Never returns (kept forever)');
    });

    it('makes unsuppress an appended event that ends the hold early', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-08-17T09:00:00Z');
        const keep = record({ ...buildKeepDecision({ senderId: 's1' }, clock) });

        clock.set('2026-08-20T09:00:00Z');
        const unsuppress = record({ ...buildUnsuppressDecision('s1', clock) });

        const status = suppressionStatus([keep, unsuppress], clock);
        expect(status.state).toBe('unsuppressed');
        expect(isReviewable(status)).toBe(true);

        // The Keep is still in the log. "Why is this back?" stays answerable.
        expect([keep, unsuppress].map((d) => d.decision)).toEqual(['keep', 'unsuppress']);
      });
    });

    it('takes an unsubscribed sender off the review list', () => {
      const clock = new TestClock('2026-08-17T09:00:00Z');
      const decision = record({ ...buildUnsubscribeDecision('s1', clock) });
      const status = suppressionStatus([decision], clock);
      expect(status.state).toBe('unsubscribed');
      expect(isReviewable(status)).toBe(false);
      // Not "hidden by keep" — it must not inflate the kept-sender footer.
      expect(isHiddenByKeep(status)).toBe(false);
    });

    it('lets a later keep re-suppress a sender that had been unsuppressed', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-08-17T09:00:00Z');
        const keep1 = record({ ...buildKeepDecision({ senderId: 's1' }, clock) });
        clock.set('2026-08-20T09:00:00Z');
        const unsuppress = record({ ...buildUnsuppressDecision('s1', clock) });
        clock.set('2026-08-21T09:00:00Z');
        const keep2 = record({ ...buildKeepDecision({ senderId: 's1' }, clock) });

        const status = suppressionStatus([keep1, unsuppress, keep2], clock);
        expect(status.state).toBe('suppressed');
        if (status.state !== 'suppressed') throw new Error('unreachable');
        expect(status.until.toISOString()).toBe('2026-11-21T09:00:00.000Z');
      });
    });

    it('reports returns today at the exact expiry instant', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-08-17T09:00:00Z');
        const keep = record({ ...buildKeepDecision({ senderId: 's1' }, clock) });
        clock.set('2026-11-17T08:59:59.999Z');
        const status = suppressionStatus([keep], clock);
        expect(returnDescription(status)).toBe('Returns today (Nov 17, 2026)');
      });
    });

    it('describes a non-suppressed status as returning now', () => {
      const clock = new TestClock('2026-08-17T09:00:00Z');
      expect(returnDescription(suppressionStatus([], clock))).toBe('Returns now');
    });
  });

  describe('legibility requirements (non-negotiable)', () => {
    it('states a concrete date in the keep confirmation', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-08-17T09:00:00Z');
        const decision = buildKeepDecision({ senderId: 's1' }, clock);
        expect(keepConfirmation('Patagonia', decision)).toBe(
          "Keeping Patagonia. Won't ask again until Nov 17, 2026.",
        );
      });
    });

    it('says so plainly when a keep is forever', () => {
      const clock = new TestClock('2026-08-17T09:00:00Z');
      const decision = buildKeepDecision({ senderId: 's1', duration: 'forever' }, clock);
      expect(keepConfirmation('Patagonia', decision)).toBe(
        "Keeping Patagonia. Won't ask again.",
      );
    });

    it('tags a returning sender with when it was kept and how long the hold was', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-05-12T09:00:00Z');
        const keep = record({ ...buildKeepDecision({ senderId: 's1' }, clock) });
        clock.set('2026-08-17T09:00:00Z');
        expect(returningTag(suppressionStatus([keep], clock))).toBe(
          'Returning — you kept this on May 12, 2026; the 3-month hold has expired.',
        );
      });
    });

    it('describes a longer hold by the length it was actually given', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-01-05T09:00:00Z');
        const keep = record({
          ...buildKeepDecision({ senderId: 's1', duration: { months: 12 } }, clock),
        });
        clock.set('2027-02-01T09:00:00Z');
        expect(returningTag(suppressionStatus([keep], clock))).toContain(
          'the 1-year hold',
        );
      });
    });

    it('describes a short day-based hold in days', () => {
      withTimeZone('UTC', () => {
        const clock = new TestClock('2026-01-05T09:00:00Z');
        const keep = record({
          ...buildKeepDecision({ senderId: 's1', duration: { days: 10 } }, clock),
        });
        clock.set('2026-02-01T09:00:00Z');
        expect(returningTag(suppressionStatus([keep], clock))).toContain(
          'the 10-day hold',
        );
      });
    });

    it('has no returning tag for a sender that is not returning', () => {
      const clock = new TestClock('2026-08-17T09:00:00Z');
      expect(returningTag(suppressionStatus([], clock))).toBeUndefined();
    });

    it('renders the footer exactly as specified', () => {
      expect(hiddenFooter(12)).toBe(
        "12 senders hidden — kept within the last 3 months. Run 'unsub kept' to see them and their return dates.",
      );
    });

    it('renders the footer even at zero, because silence is ambiguous', () => {
      expect(hiddenFooter(0)).toBe(
        'No senders hidden. Run `unsub kept` to see past decisions.',
      );
    });

    it('agrees with itself about number', () => {
      expect(hiddenFooter(1)).toContain('1 sender hidden');
      expect(
        returnDescription({
          state: 'suppressed',
          decidedAt: new Date(),
          until: new Date(),
          daysRemaining: 1,
        }),
      ).toContain('1 day (');
    });
  });
});
