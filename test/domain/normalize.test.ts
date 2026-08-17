import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RULES,
  isVariableSegment,
  normalizeListId,
  normalizeLocalPart,
  normalizedKey,
  registrableDomain,
  splitAddress,
} from '../../src/domain/normalize.js';

describe('normalisation (ADR-005)', () => {
  describe('splitAddress', () => {
    it('lowercases and splits', () => {
      expect(splitAddress('  News@Example.COM ')).toEqual({
        local: 'news',
        domain: 'example.com',
      });
    });

    it('splits on the last @, so quoted local parts survive', () => {
      expect(splitAddress('weird@name@example.com')).toEqual({
        local: 'weird@name',
        domain: 'example.com',
      });
    });

    it.each(['', 'no-at-sign', '@example.com', 'user@', 'user@localhost'])(
      'rejects %s',
      (input) => {
        expect(splitAddress(input)).toBeUndefined();
      },
    );
  });

  describe('registrableDomain uses the Public Suffix List', () => {
    it.each([
      ['news.patagonia.com', 'patagonia.com'],
      ['mail.notifications.github.com', 'github.com'],
      // A last-two-labels split would say "co.uk", which is not a domain.
      ['shop.marksandspencer.co.uk', 'marksandspencer.co.uk'],
      // `sa.edu.au` is a three-label public suffix, so even a "last three
      // labels" heuristic gets this one wrong.
      ['mail.university.sa.edu.au', 'university.sa.edu.au'],
      ['newsletter@news.example.org', 'example.org'],
      ['https://click.sendgrid.net/ls/click?upn=abc', 'sendgrid.net'],
    ])('resolves %s to %s', (input, expected) => {
      expect(registrableDomain(input)).toBe(expected);
    });

    it('returns undefined for something that is not a hostname', () => {
      expect(registrableDomain('localhost')).toBeUndefined();
      expect(registrableDomain('')).toBeUndefined();
    });
  });

  describe('isVariableSegment', () => {
    it.each(['12345', '7f3a91c2', 'a1b2c3d4e5f6', '000'])('collapses %s', (segment) => {
      expect(isVariableSegment(segment)).toBe(true);
    });

    it.each(['news', 'bounce', 'news2', 'v2', 'hello', 'team', '', 'q3'])(
      'keeps %s',
      (segment) => {
        expect(isVariableSegment(segment)).toBe(false);
      },
    );
  });

  describe('normalizeLocalPart', () => {
    it('strips subaddressing', () => {
      expect(normalizeLocalPart('you+shopping')).toEqual({
        normalized: 'you',
        collapsed: true,
      });
    });

    it('collapses VERP counters but keeps the named part', () => {
      expect(normalizeLocalPart('bounce-12345-abc').normalized).toBe('bounce-*');
    });

    it('collapses everything after a bounce prefix', () => {
      expect(normalizeLocalPart('msprvs1=abc=def').normalized).toBe('msprvs1-*');
      expect(normalizeLocalPart('srs0=xyz=aa=example.com=news').normalized).toBe(
        'srs0-*',
      );
    });

    it('leaves a stable address completely alone', () => {
      expect(normalizeLocalPart('newsletter')).toEqual({
        normalized: 'newsletter',
        collapsed: false,
      });
      expect(normalizeLocalPart('news-weekly')).toEqual({
        normalized: 'news-weekly',
        collapsed: false,
      });
    });

    it('collapses a hash in the middle of an otherwise stable address', () => {
      expect(normalizeLocalPart('patagonia-3f9a12bc-news').normalized).toBe(
        'patagonia-*-news',
      );
    });
  });

  describe('normalizeListId', () => {
    it('extracts the bracketed identity', () => {
      expect(normalizeListId('"Patagonia News" <news.patagonia.com>')).toBe(
        'news.patagonia.com',
      );
    });

    it('accepts a bare list id', () => {
      expect(normalizeListId('News.Example.Com')).toBe('news.example.com');
    });

    it('strips a surrounding quoted phrase with no brackets', () => {
      expect(normalizeListId('"news.example.com"')).toBe('news.example.com');
    });

    it.each(['', '   ', '<>'])('rejects %s', (input) => {
      expect(normalizeListId(input)).toBeUndefined();
    });
  });

  describe('normalizedKey tiers', () => {
    it('prefers List-ID over everything', () => {
      expect(
        normalizedKey({
          listId: '"Patagonia" <news.patagonia.com>',
          fromAddress: 'bounce-99182@mail.patagonia.com',
        }),
      ).toEqual({ key: 'list:news.patagonia.com', tier: 'list_id' });
    });

    it('falls back to the normalised address', () => {
      expect(normalizedKey({ fromAddress: 'newsletter@patagonia.com' })).toEqual({
        key: 'addr:newsletter@patagonia.com',
        tier: 'address',
      });
    });

    it('folds a VERP family onto one key rather than one key per message', () => {
      const keys = new Set(
        [
          'bounce-12345-abc@mail.example.com',
          'bounce-99999-xyz@mail.example.com',
          'bounce-7-q@mail.example.com',
        ].map((from) => normalizedKey({ fromAddress: from })?.key),
      );
      expect(keys.size).toBe(1);
      expect([...keys][0]).toBe('addr:bounce-*@mail.example.com');
    });

    it('falls all the way to the registrable domain only when nothing stable remains', () => {
      expect(normalizedKey({ fromAddress: '3f9a12bcd4e5@mail.example.com' })).toEqual({
        key: 'domain:example.com',
        tier: 'domain',
      });
    });

    it('keeps genuinely different subscriptions on one domain apart', () => {
      // The case ADR-005 calls out by name: these are different subscriptions
      // to a person, and the domain fallback would wrongly fold them together.
      const a = normalizedKey({ fromAddress: 'notifications@github.com' });
      const b = normalizedKey({ fromAddress: 'noreply@github.com' });
      expect(a?.key).not.toBe(b?.key);
      expect(a?.tier).toBe('address');
    });

    it('cannot collide a list named example.com with the domain example.com', () => {
      const asList = normalizedKey({
        listId: 'example.com',
        fromAddress: 'x@example.com',
      });
      const asDomain = normalizedKey({ fromAddress: '3f9a12bcd4e5@example.com' });
      expect(asList?.key).toBe('list:example.com');
      expect(asDomain?.key).toBe('domain:example.com');
      expect(asList?.key).not.toBe(asDomain?.key);
    });

    it('returns undefined for an unusable From address', () => {
      expect(normalizedKey({ fromAddress: 'garbage' })).toBeUndefined();
    });

    it('accepts overridden rules, which is the point of keeping them as data', () => {
      const relaxed = {
        ...DEFAULT_RULES,
        thresholds: { ...DEFAULT_RULES.thresholds, digits: 10 },
      };
      // With the digit threshold raised, a short counter is no longer variable.
      expect(normalizedKey({ fromAddress: 'news-2026@example.com' }, relaxed)?.key).toBe(
        'addr:news-2026@example.com',
      );
      expect(normalizedKey({ fromAddress: 'news-2026@example.com' })?.key).toBe(
        'addr:news-*@example.com',
      );
    });
  });
});
