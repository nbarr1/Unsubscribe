import { describe, expect, it } from 'vitest';

import { TestClock } from '../../src/domain/clock.js';
import { buildKeepDecision, type DecisionRecord } from '../../src/domain/decisions.js';
import {
  buildKept,
  buildReview,
  methodLabel,
  senderLabel,
  type AggregatedSender,
} from '../../src/domain/review.js';
import { withTimeZone } from '../helpers/timezone.js';

function sender(overrides: Partial<AggregatedSender> = {}): AggregatedSender {
  return {
    senderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    displayName: 'Patagonia',
    displayAddress: 'news@patagonia.example',
    messageCount: 3,
    firstSeen: '2026-05-01T00:00:00.000Z',
    lastSeen: '2026-08-01T00:00:00.000Z',
    method: 'one_click',
    confidence: 1,
    unsubscribeUri: 'https://patagonia.example/u',
    suspicious: false,
    ...overrides,
  };
}

function keptLog(
  senderId: string,
  clock: TestClock,
  duration?: 'forever',
): DecisionRecord[] {
  return [
    {
      id: 1,
      ...buildKeepDecision(
        duration === undefined ? { senderId } : { senderId, duration },
        clock,
      ),
    },
  ];
}

describe('review projection', () => {
  const clock = new TestClock('2026-08-22T09:00:00Z');

  it('sorts by volume, because that is what makes triage worth doing', () => {
    const list = buildReview(
      [
        sender({ senderId: 'a', messageCount: 3 }),
        sender({ senderId: 'b', messageCount: 91 }),
        sender({ senderId: 'c', messageCount: 12 }),
      ],
      new Map(),
      clock,
    );
    expect(list.senders.map((s) => s.senderId)).toEqual(['b', 'c', 'a']);
  });

  it('breaks a volume tie with recency', () => {
    const list = buildReview(
      [
        sender({
          senderId: 'older',
          messageCount: 5,
          lastSeen: '2026-01-01T00:00:00.000Z',
        }),
        sender({
          senderId: 'newer',
          messageCount: 5,
          lastSeen: '2026-08-01T00:00:00.000Z',
        }),
      ],
      new Map(),
      clock,
    );
    expect(list.senders[0]?.senderId).toBe('newer');
  });

  it('hides kept senders and counts them in the footer', () => {
    const list = buildReview(
      [sender({ senderId: 'a' }), sender({ senderId: 'b' })],
      new Map([['a', keptLog('a', clock)]]),
      clock,
    );
    expect(list.senders.map((s) => s.senderId)).toEqual(['b']);
    expect(list.hiddenByKeep).toBe(1);
    expect(list.footer).toContain('1 sender hidden');
  });

  it('shows kept senders when asked, without changing the hidden count', () => {
    const list = buildReview(
      [sender({ senderId: 'a' }), sender({ senderId: 'b' })],
      new Map([['a', keptLog('a', clock)]]),
      clock,
      { includeSuppressed: true },
    );
    expect(list.senders).toHaveLength(2);
    expect(list.hiddenByKeep).toBe(1);
  });

  it('attaches a returning tag once a hold expires', () => {
    withTimeZone('UTC', () => {
      const kept = new TestClock('2026-05-12T09:00:00Z');
      const later = new TestClock('2026-08-22T09:00:00Z');
      const list = buildReview(
        [sender({ senderId: 'a' })],
        new Map([['a', keptLog('a', kept)]]),
        later,
      );
      expect(list.senders[0]?.returningTag).toBe(
        'Returning — you kept this on May 12, 2026; the 3-month hold has expired.',
      );
    });
  });

  it('honours a limit', () => {
    const list = buildReview(
      [
        sender({ senderId: 'a', messageCount: 9 }),
        sender({ senderId: 'b', messageCount: 1 }),
      ],
      new Map(),
      clock,
      { limit: 1 },
    );
    expect(list.senders).toHaveLength(1);
  });

  describe('buildKept', () => {
    it('orders by soonest return, which is the order they come back in', () => {
      const early = new TestClock('2026-06-01T09:00:00Z');
      const late = new TestClock('2026-08-01T09:00:00Z');
      const kept = buildKept(
        [sender({ senderId: 'late' }), sender({ senderId: 'early' })],
        new Map([
          ['early', keptLog('early', early)],
          ['late', keptLog('late', late)],
        ]),
        clock,
      );
      expect(kept.map((s) => s.senderId)).toEqual(['early', 'late']);
    });

    it('sorts a forever keep last, since it never returns', () => {
      const kept = buildKept(
        [sender({ senderId: 'forever' }), sender({ senderId: 'soon' })],
        new Map([
          ['forever', keptLog('forever', clock, 'forever')],
          ['soon', keptLog('soon', clock)],
        ]),
        clock,
      );
      expect(kept.map((s) => s.senderId)).toEqual(['soon', 'forever']);
    });

    it('excludes senders that are not currently held', () => {
      expect(buildKept([sender({ senderId: 'a' })], new Map(), clock)).toEqual([]);
    });
  });

  describe('labels', () => {
    it('prefers the display name, then the address, then the id', () => {
      expect(senderLabel(sender())).toBe('Patagonia');
      expect(senderLabel(sender({ displayName: null }))).toBe('news@patagonia.example');
      expect(senderLabel(sender({ displayName: '', displayAddress: '' }))).toBe(
        'aaaaaaaa',
      );
    });

    it.each([
      ['one_click', 'one-click'],
      ['http_link', 'link'],
      ['mailto', 'mailto'],
      ['body_link', 'body link'],
      [null, 'none'],
    ] as const)('renders %s as %s', (method, label) => {
      expect(methodLabel(method)).toBe(label);
    });
  });
});
