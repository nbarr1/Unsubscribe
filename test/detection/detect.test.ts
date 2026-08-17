import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  detect,
  detectBodyLink,
  extractAnchors,
  hasOneClickPost,
  headersInconclusive,
  isSuspicious,
  parseListUnsubscribe,
  parseMessage,
  type Detection,
} from '../../src/detection/index.js';
import { candidateIdentities } from '../../src/domain/identity.js';
import { parseAddress, header } from '../../src/detection/mime.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixture(name: string): ReturnType<typeof parseMessage> {
  return parseMessage(readFileSync(join(FIXTURES, `${name}.eml`), 'utf8'));
}

/** Detect with headers only, as ADR-001 fetches by default. */
function detectHeadersOnly(name: string): Detection | undefined {
  return detect({ headers: fixture(name).headers });
}

/** Detect with the body available, as sync does only on fallthrough. */
function detectWithBody(name: string): Detection | undefined {
  const message = fixture(name);
  return detect({ headers: message.headers, parts: message.parts });
}

describe('detection', () => {
  describe('tier 1 — RFC 8058 one-click', () => {
    it('detects it from headers alone', () => {
      const result = detectHeadersOnly('tier1-one-click');
      expect(result).toMatchObject({
        method: 'one_click',
        uri: 'https://patagonia.example/u/one-click?t=9f2c1a',
        confidence: 1,
        suspicious: false,
      });
    });

    it('prefers the https URI over the mailto in the same header', () => {
      expect(detectHeadersOnly('tier1-one-click')?.uri).toMatch(/^https:/);
    });

    it('needs both the Post header and an https URI', () => {
      // An http URI would leak the opt-out in the clear, and RFC 8058 requires
      // https, so this must fall back to tier 2 rather than being POSTed to.
      const headers = new Map([
        ['list-unsubscribe', ['<http://insecure.example/u/1>']],
        ['list-unsubscribe-post', ['List-Unsubscribe=One-Click']],
        ['from', ['news@insecure.example']],
      ]);
      expect(detect({ headers })?.method).toBe('http_link');
    });

    it('does not treat an unknown Post value as one-click', () => {
      // Guessing here would mean POSTing to a URL that never agreed to it.
      const headers = new Map([['list-unsubscribe-post', ['List-Unsubscribe=Maybe']]]);
      expect(hasOneClickPost(headers)).toBe(false);
    });

    it('tolerates whitespace and case in the Post header', () => {
      const headers = new Map([
        ['list-unsubscribe-post', ['  list-unsubscribe = ONE-CLICK  ']],
      ]);
      expect(hasOneClickPost(headers)).toBe(true);
    });
  });

  describe('tier 2 — https URI in List-Unsubscribe', () => {
    it('detects it from headers alone', () => {
      expect(detectHeadersOnly('tier2-http-link')).toMatchObject({
        method: 'http_link',
        uri: 'https://example-shop.test/unsubscribe?id=88213',
        confidence: 0.8,
        suspicious: false,
      });
    });
  });

  describe('tier 3 — mailto', () => {
    it('detects it and keeps the subject and body parameters', () => {
      const result = detectHeadersOnly('tier3-mailto');
      expect(result?.method).toBe('mailto');
      expect(result?.uri).toBe(
        'mailto:discuss-leave@lists.example.org?subject=unsubscribe&body=please%20remove%20me',
      );
      expect(result?.confidence).toBe(0.7);
    });
  });

  describe('tier 4 — body scrape', () => {
    it('does not fire on headers alone', () => {
      // The headers carry nothing, so tier 4 is the only possibility — and it
      // must not run until a body has actually been fetched.
      expect(detectHeadersOnly('tier4-body-link')).toBeUndefined();
    });

    it('finds the footer link once the body is available', () => {
      expect(detectWithBody('tier4-body-link')).toMatchObject({
        method: 'body_link',
        uri: 'https://localcafe.test/lists/leave?c=77',
        confidence: 0.4,
        suspicious: false,
      });
    });

    it('handles quoted-printable soft breaks inside the href', () => {
      // The fixture's href is split by a soft line break mid-URL.
      expect(detectWithBody('tier4-body-link')?.uri).toBe(
        'https://localcafe.test/lists/leave?c=77',
      );
    });

    it('matches a non-English link, decoded from base64', () => {
      expect(detectWithBody('tier4-multilingual')).toMatchObject({
        method: 'body_link',
        uri: 'https://librairie.example/liste/stop',
      });
    });

    it('falls back to the URL when the link text says only "Click here"', () => {
      const result = detectWithBody('tier4-url-token-only');
      expect(result?.uri).toBe('https://gadgets.example/subscription/opt-out?u=41');
      expect(result?.evidence).toContain('URL matched');
    });

    it('prefers a strong unsubscribe link over a preferences link', () => {
      const html = `
        <a href="https://x.example/prefs">Manage preferences</a>
        <a href="https://x.example/leave">Unsubscribe</a>`;
      const found = detectBodyLink(html);
      expect(found?.uri).toBe('https://x.example/leave');
      expect(found?.confidence).toBe(0.4);
    });

    it('scores a bare preferences link lower, since it does not unsubscribe you', () => {
      const found = detectBodyLink('<a href="https://x.example/p">Email preferences</a>');
      expect(found?.confidence).toBe(0.3);
    });

    it('ignores anchors that are not http(s)', () => {
      expect(
        detectBodyLink('<a href="mailto:x@y.example">Unsubscribe</a>'),
      ).toBeUndefined();
    });

    it('does not match intent in a host name', () => {
      // A vendor naming their tracking domain "unsubscribe-cdn" is not intent.
      expect(
        detectBodyLink('<a href="https://unsubscribe-cdn.example/pixel.gif">.</a>'),
      ).toBeUndefined();
    });
  });

  describe('a message with no signal at all', () => {
    it('is not detected, even when the prose mentions unsubscribing', () => {
      // Personal mail that happens to use the word must never be aggregated.
      expect(detectHeadersOnly('no-signal')).toBeUndefined();
      expect(detectWithBody('no-signal')).toBeUndefined();
    });
  });

  describe('the headers-only gate (ADR-001)', () => {
    it.each(['tier1-one-click', 'tier2-http-link', 'tier3-mailto', 'list-id-grouping'])(
      'does not ask for the body of %s',
      (name) => {
        expect(headersInconclusive(fixture(name).headers)).toBe(false);
      },
    );

    it.each(['tier4-body-link', 'tier4-multilingual', 'no-signal'])(
      'asks for the body of %s',
      (name) => {
        expect(headersInconclusive(fixture(name).headers)).toBe(true);
      },
    );
  });

  describe('the suspicious flag', () => {
    it('fires when the target matches neither the From domain nor any DKIM d=', () => {
      const result = detectHeadersOnly('suspicious-domain');
      expect(result?.suspicious).toBe(true);
      expect(result?.uri).toContain('sketchy-optout.test');
    });

    it('does not fire when the target is the From domain', () => {
      expect(isSuspicious('https://shop.example/u/1', 'news@shop.example', [])).toBe(
        false,
      );
    });

    it('does not fire when the target matches a DKIM d= domain', () => {
      // Unsubscribing through an ESP's own domain is completely normal.
      expect(
        isSuspicious('https://click.sendgrid.net/u/1', 'news@shop.example', [
          'sendgrid.net',
        ]),
      ).toBe(false);
    });

    it('compares registrable domains, not host strings', () => {
      expect(
        isSuspicious('https://email.marketing.shop.example/u/1', 'news@shop.example', []),
      ).toBe(false);
    });

    it('applies to mailto targets too', () => {
      expect(isSuspicious('mailto:leave@other.example', 'news@shop.example', [])).toBe(
        true,
      );
      expect(isSuspicious('mailto:leave@shop.example', 'news@shop.example', [])).toBe(
        false,
      );
    });

    it('does not fire on an unparseable target', () => {
      // Flagging something we could not even read would be noise, not a signal.
      expect(isSuspicious('not a uri', 'news@shop.example', [])).toBe(false);
    });
  });

  describe('parseListUnsubscribe', () => {
    it('reads several angle-bracketed URIs', () => {
      expect(parseListUnsubscribe('<https://a.example/u>, <mailto:b@a.example>')).toEqual(
        ['https://a.example/u', 'mailto:b@a.example'],
      );
    });

    it('reads a folded header, so a second URI is not lost at the fold', () => {
      expect(
        parseListUnsubscribe('<https://a.example/u>, <mailto:b@a.example>'),
      ).toHaveLength(2);
    });

    it('accepts a bare URL, which real senders do emit', () => {
      expect(parseListUnsubscribe('https://a.example/u')).toEqual([
        'https://a.example/u',
      ]);
    });

    it('yields nothing for a value with no URI in it', () => {
      expect(parseListUnsubscribe('NO')).toEqual([]);
      expect(parseListUnsubscribe('<>')).toEqual([]);
    });
  });

  describe('extractAnchors', () => {
    it('reads href, text, title and aria-label', () => {
      const anchors = extractAnchors(
        `<a href="https://x.example/u" title="Stop these emails" aria-label="unsub">
           <img src="x.png"> Click <b>here</b>
         </a>`,
      );
      expect(anchors).toEqual([
        {
          href: 'https://x.example/u',
          text: 'Click here',
          title: 'Stop these emails',
          ariaLabel: 'unsub',
        },
      ]);
    });

    it('decodes entities in the href', () => {
      expect(
        extractAnchors('<a href="https://x.example/u?a=1&amp;b=2">go</a>')[0]?.href,
      ).toBe('https://x.example/u?a=1&b=2');
    });

    it('accepts unquoted attributes', () => {
      expect(extractAnchors('<a href=https://x.example/u>go</a>')[0]?.href).toBe(
        'https://x.example/u',
      );
    });

    it('skips anchors with no href', () => {
      expect(extractAnchors('<a name="top">anchor</a>')).toEqual([]);
    });
  });

  describe('fixtures that exist for the identity layer', () => {
    it('groups a rotating VERP sender onto one normalised key', () => {
      const first = fixture('verp-rotating-sender');
      const second = fixture('verp-rotating-sender-2');

      const keyOf = (message: ReturnType<typeof parseMessage>): string | undefined =>
        candidateIdentities({
          fromAddress: parseAddress(header(message.headers, 'from')).address,
        }).find((i) => i.kind === 'normalized_key')?.value;

      expect(keyOf(first)).toBe(keyOf(second));
      expect(keyOf(first)).toBe('addr:bounce-*@bounce.mailer.test');
    });

    it('uses List-ID rather than a rotating From address', () => {
      const message = fixture('list-id-grouping');
      const identities = candidateIdentities({
        fromAddress: parseAddress(header(message.headers, 'from')).address,
        listId: header(message.headers, 'list-id'),
      });
      expect(identities).toContainEqual({
        kind: 'list_id',
        value: 'dispatch.newsplatform.test',
      });
      expect(identities).toContainEqual({
        kind: 'normalized_key',
        value: 'list:dispatch.newsplatform.test',
      });
    });
  });
});
