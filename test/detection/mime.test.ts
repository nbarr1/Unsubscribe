import { describe, expect, it } from 'vitest';

import {
  decodeEncodedWords,
  decodeQuotedPrintable,
  dkimDomains,
  header,
  headerAll,
  htmlPart,
  parseAddress,
  parseContentType,
  parseHeaders,
  parseMessage,
  splitMessage,
  textPart,
} from '../../src/detection/mime.js';
import {
  matchPreferenceToken,
  matchUnsubscribeToken,
  matchUrlToken,
  normalizeForMatch,
} from '../../src/detection/tokens.js';

describe('mime', () => {
  describe('parseHeaders', () => {
    it('unfolds continuation lines', () => {
      // Truncating at the fold is how a second List-Unsubscribe URI goes
      // missing, so this is the case that matters.
      const headers = parseHeaders(
        'List-Unsubscribe: <https://a.example/u>,\n\t<mailto:b@a.example>\nFrom: x@y.example',
      );
      expect(header(headers, 'list-unsubscribe')).toBe(
        '<https://a.example/u>, <mailto:b@a.example>',
      );
    });

    it('is case-insensitive on lookup', () => {
      const headers = parseHeaders('SUBJECT: hi');
      expect(header(headers, 'subject')).toBe('hi');
    });

    it('keeps repeated headers, which DKIM-Signature legitimately is', () => {
      const headers = parseHeaders(
        'DKIM-Signature: v=1; d=a.example\nDKIM-Signature: v=1; d=b.example',
      );
      expect(headerAll(headers, 'dkim-signature')).toHaveLength(2);
    });

    it('ignores garbage lines rather than throwing', () => {
      const headers = parseHeaders('not a header\nFrom: x@y.example');
      expect(header(headers, 'from')).toBe('x@y.example');
    });

    it('returns undefined for a header that is absent', () => {
      expect(header(parseHeaders('From: x@y.example'), 'list-id')).toBeUndefined();
      expect(headerAll(parseHeaders(''), 'from')).toEqual([]);
    });
  });

  describe('splitMessage', () => {
    it('splits headers from body at the blank line', () => {
      const { headers, body } = splitMessage('From: x@y.example\n\nhello\nthere');
      expect(header(headers, 'from')).toBe('x@y.example');
      expect(body).toBe('hello\nthere');
    });

    it('handles CRLF line endings, which is what the wire actually uses', () => {
      const { body } = splitMessage('From: x@y.example\r\n\r\nhello');
      expect(body).toBe('hello');
    });

    it('handles a message with headers and no body', () => {
      expect(splitMessage('From: x@y.example').body).toBe('');
    });
  });

  describe('decodeEncodedWords', () => {
    it('decodes a Q-encoded word, with _ standing for a space', () => {
      expect(decodeEncodedWords('=?UTF-8?Q?Autumn_sale_=E2=80=94_30%25_off?=')).toBe(
        'Autumn sale — 30%25 off',
      );
    });

    it('decodes a B-encoded word', () => {
      expect(decodeEncodedWords('=?UTF-8?B?TGEgTGlicmFpcmll?=')).toBe('La Librairie');
    });

    it('leaves plain text alone', () => {
      expect(decodeEncodedWords('lunch?')).toBe('lunch?');
    });

    it('leaves an undecodable word as it found it', () => {
      const input = '=?NOT-A-CHARSET?Q?abc?=';
      expect(decodeEncodedWords(input)).toBe('abc');
    });
  });

  describe('decodeQuotedPrintable', () => {
    it('joins soft line breaks', () => {
      expect(decodeQuotedPrintable('Manage your email =\npreferences')).toBe(
        'Manage your email preferences',
      );
    });

    it('decodes hex escapes as UTF-8', () => {
      expect(decodeQuotedPrintable('caf=C3=A9')).toBe('café');
    });

    it('leaves a lone = that is not an escape', () => {
      expect(decodeQuotedPrintable('a=b')).toBe('a=b');
    });
  });

  describe('parseContentType', () => {
    it('reads the type and its parameters', () => {
      const parsed = parseContentType('multipart/alternative; boundary="b0undary42"');
      expect(parsed.type).toBe('multipart/alternative');
      expect(parsed.parameters.get('boundary')).toBe('b0undary42');
    });

    it('defaults to text/plain when absent, as RFC 2045 says', () => {
      expect(parseContentType(undefined).type).toBe('text/plain');
    });
  });

  describe('parseMessage', () => {
    it('decodes a multipart/alternative into its parts', () => {
      const raw = [
        'Content-Type: multipart/alternative; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain',
        '',
        'plain text',
        '',
        '--b',
        'Content-Type: text/html',
        '',
        '<p>html</p>',
        '',
        '--b--',
      ].join('\n');
      const { parts } = parseMessage(raw);
      expect(textPart(parts)?.trim()).toBe('plain text');
      expect(htmlPart(parts)?.trim()).toBe('<p>html</p>');
    });

    it('skips non-text parts rather than decoding attachments', () => {
      const raw = [
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: application/pdf',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQK',
        '',
        '--b--',
      ].join('\n');
      expect(parseMessage(raw).parts).toEqual([]);
    });

    it('walks a nested multipart', () => {
      const raw = [
        'Content-Type: multipart/mixed; boundary="outer"',
        '',
        '--outer',
        'Content-Type: multipart/alternative; boundary="inner"',
        '',
        '--inner',
        'Content-Type: text/html',
        '',
        '<p>nested</p>',
        '',
        '--inner--',
        '--outer--',
      ].join('\n');
      expect(htmlPart(parseMessage(raw).parts)?.trim()).toBe('<p>nested</p>');
    });

    it('gives up on a multipart with no boundary rather than looping', () => {
      expect(parseMessage('Content-Type: multipart/mixed\n\nbody').parts).toEqual([]);
    });
  });

  describe('parseAddress', () => {
    it.each([
      ['"Patagonia" <news@patagonia.example>', 'Patagonia', 'news@patagonia.example'],
      ['Example Shop <news@shop.example>', 'Example Shop', 'news@shop.example'],
      ['news@shop.example', undefined, 'news@shop.example'],
      ['<news@shop.example>', undefined, 'news@shop.example'],
    ])('reads %s', (input, name, address) => {
      expect(parseAddress(input)).toEqual({ name, address });
    });

    it('decodes an encoded display name', () => {
      expect(parseAddress('=?UTF-8?B?TGEgTGlicmFpcmll?= <a@b.example>').name).toBe(
        'La Librairie',
      );
    });

    it('yields an empty address when the header is missing', () => {
      expect(parseAddress(undefined)).toEqual({ address: '' });
    });
  });

  describe('dkimDomains', () => {
    it('reads d= from every signature', () => {
      const headers = parseHeaders(
        'DKIM-Signature: v=1; a=rsa-sha256; d=a.example; s=k1\n' +
          'DKIM-Signature: v=1; d=b.example; s=k2',
      );
      expect(dkimDomains(headers)).toEqual(['a.example', 'b.example']);
    });

    it('reads d= across a folded signature', () => {
      const headers = parseHeaders(
        'DKIM-Signature: v=1; a=rsa-sha256;\n\td=folded.example; s=k1',
      );
      expect(dkimDomains(headers)).toEqual(['folded.example']);
    });

    it('does not mistake bh= or b= for d=', () => {
      const headers = parseHeaders('DKIM-Signature: v=1; bh=abc; b=xyz; d=real.example');
      expect(dkimDomains(headers)).toEqual(['real.example']);
    });

    it('returns nothing when there is no signature', () => {
      expect(dkimDomains(parseHeaders('From: a@b.example'))).toEqual([]);
    });
  });
});

describe('tokens', () => {
  it('flattens separators so opt-out, opt_out and "opt  out" all match', () => {
    for (const text of ['Opt-Out', 'opt_out', 'OPT   OUT']) {
      expect(matchUnsubscribeToken(text)).toBeDefined();
    }
  });

  it('strips accents so désabonner matches an unaccented list entry', () => {
    expect(normalizeForMatch('Se désabonner')).toBe('se desabonner');
    expect(matchUnsubscribeToken('Se désabonner')).toBeDefined();
  });

  it('matches other languages from the maintained list', () => {
    for (const text of ['Abbestellen', 'Uitschrijven', 'Darse de baja', 'Wypisz się']) {
      expect(matchUnsubscribeToken(text)).toBeDefined();
    }
  });

  it('separates preference phrases from unsubscribe phrases', () => {
    expect(matchUnsubscribeToken('Manage preferences')).toBeUndefined();
    expect(matchPreferenceToken('Manage preferences')).toBeDefined();
  });

  it('matches a URL on its path and query only', () => {
    expect(matchUrlToken('https://x.example/subscription/opt-out?u=41')).toBeDefined();
    expect(matchUrlToken('https://unsubscribe-cdn.example/pixel.gif')).toBeUndefined();
  });

  it('falls back to matching the whole string for a relative href', () => {
    expect(matchUrlToken('/lists/unsubscribe')).toBeDefined();
  });

  it('matches nothing in empty text', () => {
    expect(matchUnsubscribeToken('')).toBeUndefined();
    expect(matchUnsubscribeToken('   ')).toBeUndefined();
  });
});
