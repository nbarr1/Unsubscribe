import { describe, expect, it } from 'vitest';

import {
  candidateIdentities,
  isResolving,
  resolveSender,
  type Identity,
  type IdentityMatch,
} from '../../src/domain/identity.js';
import { DEFAULT_RULES } from '../../src/domain/normalize.js';

function match(kind: Identity['kind'], value: string, senderId: string): IdentityMatch {
  return { identity: { kind, value }, senderId };
}

describe('sender identity (ADR-005)', () => {
  describe('candidateIdentities', () => {
    it('records List-ID, the literal address and the normalised key', () => {
      expect(
        candidateIdentities({
          fromAddress: 'Newsletter@Patagonia.com',
          listId: '"Patagonia" <news.patagonia.com>',
        }),
      ).toEqual([
        { kind: 'list_id', value: 'news.patagonia.com' },
        { kind: 'from_address', value: 'newsletter@patagonia.com' },
        { kind: 'normalized_key', value: 'list:news.patagonia.com' },
      ]);
    });

    it('omits List-ID when the message had none', () => {
      const kinds = candidateIdentities({ fromAddress: 'news@example.com' }).map(
        (i) => i.kind,
      );
      expect(kinds).toEqual(['from_address', 'normalized_key']);
    });

    it('records DKIM d= domains as registrable domains', () => {
      const identities = candidateIdentities({
        fromAddress: 'news@example.com',
        dkimDomains: ['mail.example.com', 'click.sendgrid.net'],
      });
      expect(identities).toContainEqual({ kind: 'dkim_domain', value: 'example.com' });
      expect(identities).toContainEqual({ kind: 'dkim_domain', value: 'sendgrid.net' });
    });

    it('de-duplicates', () => {
      const identities = candidateIdentities({
        fromAddress: 'news@example.com',
        dkimDomains: ['example.com', 'mail.example.com'],
      });
      expect(identities.filter((i) => i.kind === 'dkim_domain')).toHaveLength(1);
    });

    it('drops a DKIM domain that is not a hostname', () => {
      const identities = candidateIdentities({
        fromAddress: 'news@example.com',
        dkimDomains: ['localhost', ''],
      });
      expect(identities.some((i) => i.kind === 'dkim_domain')).toBe(false);
    });

    it('yields nothing but DKIM for an unusable From address', () => {
      expect(candidateIdentities({ fromAddress: 'garbage' })).toEqual([]);
    });
  });

  describe('which identities resolve', () => {
    it('resolves on list_id, from_address and normalized_key', () => {
      for (const kind of ['list_id', 'from_address', 'normalized_key'] as const) {
        expect(isResolving({ kind, value: 'x' })).toBe(true);
      }
    });

    it('does not resolve on dkim_domain', () => {
      // A d= domain is very often the sending platform, shared by thousands of
      // unrelated senders. Resolving on it would fold every SendGrid customer
      // into one sender, so a single Keep would hide hundreds of newsletters.
      expect(isResolving({ kind: 'dkim_domain', value: 'sendgrid.net' })).toBe(false);
    });

    it('never merges two senders that only share a sending platform', () => {
      const patagonia = candidateIdentities({
        fromAddress: 'news@patagonia.com',
        dkimDomains: ['sendgrid.net'],
      });
      const other = candidateIdentities({
        fromAddress: 'news@someshop.example',
        dkimDomains: ['sendgrid.net'],
      });

      // Patagonia is already known, including its shared d= domain.
      const known = patagonia.map((i) => match(i.kind, i.value, 'patagonia'));

      expect(resolveSender(other, known).kind).toBe('new');
    });
  });

  describe('resolveSender', () => {
    it('creates a sender when nothing matches', () => {
      const candidates = candidateIdentities({ fromAddress: 'news@example.com' });
      const resolution = resolveSender(candidates, []);
      expect(resolution).toEqual({ kind: 'new', identities: candidates });
    });

    it('matches an existing sender on any resolving identity', () => {
      const candidates = candidateIdentities({ fromAddress: 'news@example.com' });
      const resolution = resolveSender(candidates, [
        match('normalized_key', 'addr:news@example.com', 's1'),
      ]);
      expect(resolution.kind).toBe('existing');
      if (resolution.kind !== 'existing') throw new Error('unreachable');
      expect(resolution.senderId).toBe('s1');
      // The identity that matched is already stored; only the rest are new.
      expect(resolution.newIdentities).toEqual([
        { kind: 'from_address', value: 'news@example.com' },
      ]);
    });

    it('holds a VERP family together across rotating addresses', () => {
      const first = candidateIdentities({
        fromAddress: 'bounce-12345-abc@mail.example.com',
      });
      const known = first.map((i) => match(i.kind, i.value, 's1'));

      const second = candidateIdentities({
        fromAddress: 'bounce-99999-xyz@mail.example.com',
      });
      const resolution = resolveSender(second, known);
      expect(resolution.kind).toBe('existing');
      if (resolution.kind !== 'existing') throw new Error('unreachable');
      expect(resolution.senderId).toBe('s1');
      // The rotating literal address is new; the normalised key is what matched.
      expect(resolution.newIdentities).toEqual([
        { kind: 'from_address', value: 'bounce-99999-xyz@mail.example.com' },
      ]);
    });

    it('reports ambiguity instead of silently merging two senders', () => {
      const candidates = candidateIdentities({
        fromAddress: 'news@example.com',
        listId: 'weekly.example.com',
      });
      const resolution = resolveSender(candidates, [
        match('list_id', 'weekly.example.com', 's1'),
        match('from_address', 'news@example.com', 's2'),
      ]);
      expect(resolution.kind).toBe('ambiguous');
      if (resolution.kind !== 'ambiguous') throw new Error('unreachable');
      // List-ID has priority, so that is the sender the message attaches to.
      expect(resolution.senderId).toBe('s1');
      expect(resolution.alsoMatched).toEqual(['s2']);
    });

    it('never takes an identity that another sender already owns', () => {
      // Taking it would move history between senders — the auto-split ADR-005
      // forbids.
      const candidates = candidateIdentities({
        fromAddress: 'news@example.com',
        listId: 'weekly.example.com',
      });
      const resolution = resolveSender(candidates, [
        match('list_id', 'weekly.example.com', 's1'),
        match('from_address', 'news@example.com', 's2'),
      ]);
      if (resolution.kind !== 'ambiguous') throw new Error('unreachable');
      expect(resolution.newIdentities).toEqual([
        { kind: 'normalized_key', value: 'list:weekly.example.com' },
      ]);
    });

    it('ignores a dkim_domain match when picking the sender', () => {
      const candidates = candidateIdentities({
        fromAddress: 'news@example.com',
        dkimDomains: ['sendgrid.net'],
      });
      const resolution = resolveSender(candidates, [
        match('dkim_domain', 'sendgrid.net', 's1'),
      ]);
      expect(resolution.kind).toBe('new');
    });
  });

  /**
   * The obligation ADR-005 states explicitly: changing a normalisation rule and
   * re-running must not orphan or resurface any existing decision.
   *
   * This is the whole reason decisions foreign-key to an opaque sender id
   * rather than to a normalised key, so it is worth proving rather than
   * asserting.
   */
  describe('a normalisation rule change cannot orphan a decision', () => {
    it('keeps the same sender id after the rule change', () => {
      const from = 'news-2026@example.com';

      // Under today's rules, `2026` is a counter and gets collapsed.
      const before = candidateIdentities({ fromAddress: from });
      expect(before).toContainEqual({
        kind: 'normalized_key',
        value: 'addr:news-*@example.com',
      });

      // The user reviews this sender and clicks Keep. The decision points at
      // the surrogate id, and at nothing else.
      const senderId = 'sender-uuid-1';
      const stored = before.map((i) => match(i.kind, i.value, senderId));
      const decision = { senderId, decision: 'keep' as const };

      // Now the rule changes: four-digit segments are years, not counters.
      const newRules = {
        ...DEFAULT_RULES,
        thresholds: { ...DEFAULT_RULES.thresholds, digits: 5 },
      };

      const after = candidateIdentities({ fromAddress: from }, newRules);
      expect(after).toContainEqual({
        kind: 'normalized_key',
        value: 'addr:news-2026@example.com',
      });

      // Re-ingesting under the new rules still lands on the same sender,
      // because the literal from_address identity still matches.
      const resolution = resolveSender(after, stored);
      expect(resolution.kind).toBe('existing');
      if (resolution.kind !== 'existing') throw new Error('unreachable');
      expect(resolution.senderId).toBe(senderId);

      // The decision is untouched and still points at a live sender.
      expect(decision.senderId).toBe(resolution.senderId);

      // The rule change ADDED an identity. It invalidated nothing.
      expect(resolution.newIdentities).toEqual([
        { kind: 'normalized_key', value: 'addr:news-2026@example.com' },
      ]);
    });

    it('holds even when the tier itself changes', () => {
      // A rule change that moves a sender from the address tier to the domain
      // tier is the worst case: the normalised key changes completely.
      const from = 'news2xyz@mail.example.com';
      const senderId = 'sender-uuid-2';

      const strict = {
        ...DEFAULT_RULES,
        thresholds: { ...DEFAULT_RULES.thresholds, mixed: 4 },
      };
      const before = candidateIdentities({ fromAddress: from }, strict);
      expect(before).toContainEqual({
        kind: 'normalized_key',
        value: 'domain:example.com',
      });

      const stored = before.map((i) => match(i.kind, i.value, senderId));

      // Under the default rules the same address keeps its literal key.
      const after = candidateIdentities({ fromAddress: from });
      expect(after).toContainEqual({
        kind: 'normalized_key',
        value: 'addr:news2xyz@mail.example.com',
      });

      const resolution = resolveSender(after, stored);
      expect(resolution.kind).toBe('existing');
      if (resolution.kind !== 'existing') throw new Error('unreachable');
      expect(resolution.senderId).toBe(senderId);
    });
  });
});
