import { describe, expect, it, vi } from 'vitest';

import { TestClock } from '../../src/domain/clock.js';
import {
  executeUnsubscribe,
  isStillSending,
  MAX_REDIRECTS,
  parseMailto,
  type ExecuteDependencies,
  type ExecuteRequest,
} from '../../src/unsubscribe/execute.js';

function deps(overrides: Partial<ExecuteDependencies> = {}): ExecuteDependencies {
  return {
    clock: new TestClock('2026-08-17T09:00:00Z'),
    openBrowser: vi.fn(async () => undefined),
    ...overrides,
  };
}

function request(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    senderId: 's1',
    senderLabel: 'Patagonia',
    method: 'one_click',
    uri: 'https://patagonia.example/u/1',
    suspicious: false,
    ...overrides,
  };
}

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('unsubscribe execution', () => {
  describe('one-click (RFC 8058)', () => {
    it('POSTs the required body and records the status', async () => {
      const fetch = vi.fn(async () => response(200));
      const attempt = await executeUnsubscribe(request(), deps({ fetch }));

      expect(attempt.result).toBe('success');
      expect(attempt.httpStatus).toBe(200);

      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://patagonia.example/u/1');
      expect(init.method).toBe('POST');
      expect(init.body).toBe('List-Unsubscribe=One-Click');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
    });

    it('sends an abort signal, so a hung endpoint cannot hang the review', async () => {
      const fetch = vi.fn(async () => response(200));
      await executeUnsubscribe(request(), deps({ fetch }));
      const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('follows a small number of redirects', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          response(302, { location: 'https://patagonia.example/u/2' }),
        )
        .mockResolvedValueOnce(response(204));

      const attempt = await executeUnsubscribe(request(), deps({ fetch }));
      expect(attempt.result).toBe('success');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1]?.[0]).toBe('https://patagonia.example/u/2');
    });

    it('resolves a relative redirect against the current URL', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(response(301, { location: '/confirmed' }))
        .mockResolvedValueOnce(response(200));
      await executeUnsubscribe(request(), deps({ fetch }));
      expect(fetch.mock.calls[1]?.[0]).toBe('https://patagonia.example/confirmed');
    });

    it('gives up rather than chasing redirects indefinitely', async () => {
      const fetch = vi.fn(async () =>
        response(302, { location: 'https://patagonia.example/loop' }),
      );
      const attempt = await executeUnsubscribe(request(), deps({ fetch }));
      expect(attempt.result).toBe('failed');
      expect(attempt.error).toContain('redirects');
      expect(fetch).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
    });

    it('records a failure status rather than claiming success', async () => {
      const fetch = vi.fn(async () => response(500));
      const attempt = await executeUnsubscribe(request(), deps({ fetch }));
      expect(attempt.result).toBe('failed');
      expect(attempt.httpStatus).toBe(500);
    });

    it('records a network error', async () => {
      const fetch = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      const attempt = await executeUnsubscribe(request(), deps({ fetch }));
      expect(attempt.result).toBe('failed');
      expect(attempt.error).toBe('ECONNREFUSED');
    });
  });

  describe('link', () => {
    it('opens the browser and never fetches the URL', async () => {
      // A silent fetch can trigger a GET-based action, land in a preference
      // centre that needs input, or confirm to a spammer that the address is
      // live. So a person looks at it.
      const openBrowser = vi.fn(async () => undefined);
      const fetch = vi.fn(async () => response(200));

      const attempt = await executeUnsubscribe(
        request({ method: 'http_link', uri: 'https://shop.example/u/9' }),
        deps({ openBrowser, fetch }),
      );

      expect(attempt.result).toBe('pending_manual');
      expect(openBrowser).toHaveBeenCalledWith('https://shop.example/u/9');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('treats a body-scraped link the same way', async () => {
      const fetch = vi.fn(async () => response(200));
      const attempt = await executeUnsubscribe(
        request({ method: 'body_link' }),
        deps({ fetch }),
      );
      expect(attempt.result).toBe('pending_manual');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('prints the URL when no browser can be opened', async () => {
      const attempt = await executeUnsubscribe(
        request({ method: 'http_link', uri: 'https://shop.example/u/9' }),
        deps({
          openBrowser: async () => {
            throw new Error('no display');
          },
        }),
      );
      expect(attempt.result).toBe('pending_manual');
      expect(attempt.message).toContain('https://shop.example/u/9');
    });
  });

  describe('mailto', () => {
    it('sends through the account, honouring subject and body', async () => {
      const send = vi.fn(async () => ({ messageId: '<sent-1@example.com>' }));
      const attempt = await executeUnsubscribe(
        request({
          method: 'mailto',
          uri: 'mailto:leave@lists.example.org?subject=unsubscribe%20me&body=please',
        }),
        deps({ provider: { send } }),
      );

      expect(attempt.result).toBe('success');
      expect(attempt.sentMessageId).toBe('<sent-1@example.com>');
      expect(send).toHaveBeenCalledWith({
        to: 'leave@lists.example.org',
        subject: 'unsubscribe me',
        body: 'please',
      });
    });

    it('says so plainly when the mail source cannot send', async () => {
      const attempt = await executeUnsubscribe(
        request({ method: 'mailto', uri: 'mailto:leave@lists.example.org' }),
        deps({ provider: undefined }),
      );
      expect(attempt.result).toBe('failed');
      expect(attempt.message).toContain('leave@lists.example.org');
    });

    it('records a send failure', async () => {
      const send = vi.fn(async () => {
        throw new Error('SMTP 550');
      });
      const attempt = await executeUnsubscribe(
        request({ method: 'mailto', uri: 'mailto:leave@lists.example.org' }),
        deps({ provider: { send } }),
      );
      expect(attempt.result).toBe('failed');
      expect(attempt.error).toBe('SMTP 550');
    });
  });

  describe('suspicious senders', () => {
    it('does nothing at all without an explicit confirmation', async () => {
      const fetch = vi.fn(async () => response(200));
      const openBrowser = vi.fn(async () => undefined);
      const send = vi.fn(async () => ({ messageId: 'x' }));

      for (const method of ['one_click', 'http_link', 'mailto', 'body_link'] as const) {
        const attempt = await executeUnsubscribe(
          request({ method, suspicious: true, uri: 'https://sketchy.example/o?e=you' }),
          deps({ fetch, openBrowser, provider: { send } }),
        );
        expect(attempt.result).toBe('skipped_suspicious');
      }

      expect(fetch).not.toHaveBeenCalled();
      expect(openBrowser).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('proceeds once the user confirms', async () => {
      const fetch = vi.fn(async () => response(200));
      const attempt = await executeUnsubscribe(
        request({ suspicious: true, confirmSuspicious: true }),
        deps({ fetch }),
      );
      expect(attempt.result).toBe('success');
    });

    it('explains why it did nothing and how to override', async () => {
      const attempt = await executeUnsubscribe(
        request({ suspicious: true }),
        deps({ fetch: vi.fn() }),
      );
      expect(attempt.message).toContain('--confirm-suspicious');
    });
  });

  describe('parseMailto', () => {
    it('defaults subject and body when the URI carries none', () => {
      expect(parseMailto('mailto:leave@x.example')).toEqual({
        to: 'leave@x.example',
        subject: 'unsubscribe',
        body: 'unsubscribe',
      });
    });

    it('decodes the address', () => {
      expect(parseMailto('mailto:a%2Bb@x.example')?.to).toBe('a+b@x.example');
    });

    it.each(['https://x.example', 'mailto:', 'mailto:notanaddress'])(
      'rejects %s',
      (input) => {
        expect(parseMailto(input)).toBeUndefined();
      },
    );
  });

  describe('still_sending', () => {
    it('flags mail arriving more than ten days after the unsubscribe', () => {
      const attempted = new Date('2026-08-01T00:00:00Z');
      expect(isStillSending(attempted, new Date('2026-08-05T00:00:00Z'))).toBe(false);
      expect(isStillSending(attempted, new Date('2026-08-11T00:00:00Z'))).toBe(false);
      expect(isStillSending(attempted, new Date('2026-08-12T00:00:00Z'))).toBe(true);
    });
  });
});
