import type { UnsubscribeMethod } from '../detection/detect.js';
import type { Clock } from '../domain/clock.js';
import { toIso } from '../domain/time.js';
import type { MailProvider } from '../providers/types.js';

/**
 * Executing an unsubscribe.
 *
 * Each method has its own rule, and the differences are not incidental — they
 * are the reason this is not one function that fetches a URL.
 */

export type AttemptResult =
  'success' | 'pending_manual' | 'failed' | 'skipped_suspicious';

export interface UnsubscribeAttempt {
  senderId: string;
  method: UnsubscribeMethod;
  attemptedAt: string;
  result: AttemptResult;
  httpStatus?: number | undefined;
  targetUri?: string | undefined;
  sentMessageId?: string | undefined;
  error?: string | undefined;
  /** What to tell the user, in a sentence. */
  message: string;
}

export interface ExecuteRequest {
  senderId: string;
  senderLabel: string;
  method: UnsubscribeMethod;
  uri: string;
  suspicious: boolean;
  /** Set by an explicit user flag; required before acting on a suspicious sender. */
  confirmSuspicious?: boolean | undefined;
}

export interface ExecuteDependencies {
  clock: Clock;
  /** Opens a URL in the user's browser. */
  openBrowser: (url: string) => Promise<void>;
  /** Sends mail through the authenticated account, for `mailto:`. */
  provider?: Pick<MailProvider, 'send'> | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

/** A sane timeout. A hung unsubscribe endpoint must not hang the review. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** A small redirect limit. Enough for the usual hop, not an open-ended chase. */
export const MAX_REDIRECTS = 3;

export async function executeUnsubscribe(
  request: ExecuteRequest,
  deps: ExecuteDependencies,
): Promise<UnsubscribeAttempt> {
  const attemptedAt = toIso(deps.clock.now());

  const base = {
    senderId: request.senderId,
    method: request.method,
    attemptedAt,
    targetUri: request.uri,
  };

  // A suspicious target is one whose domain matches neither the From domain nor
  // any DKIM d=. Acting on it is exactly what confirms to a list-washer that
  // this address is live, so the default is to do nothing at all.
  if (request.suspicious && request.confirmSuspicious !== true) {
    return {
      ...base,
      result: 'skipped_suspicious',
      message:
        `Skipped ${request.senderLabel}: the unsubscribe link points at a domain ` +
        `unrelated to the sender (${request.uri}). ` +
        'Re-run with --confirm-suspicious if you are sure.',
    };
  }

  switch (request.method) {
    case 'one_click':
      return oneClick(request, deps, base);
    case 'http_link':
    case 'body_link':
      return manualLink(request, deps, base);
    case 'mailto':
      return mailto(request, deps, base);
  }
}

type AttemptBase = Pick<
  UnsubscribeAttempt,
  'senderId' | 'method' | 'attemptedAt' | 'targetUri'
>;

/**
 * RFC 8058 one-click: a single POST with the body `List-Unsubscribe=One-Click`.
 *
 * The only method safe to execute automatically, because the sender explicitly
 * declared that this URL accepts exactly this POST and that it has no side
 * effect beyond unsubscribing.
 */
async function oneClick(
  request: ExecuteRequest,
  deps: ExecuteDependencies,
  base: AttemptBase,
): Promise<UnsubscribeAttempt> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let url = request.uri;
    let response: Response | undefined;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        redirect: 'manual',
        signal: controller.signal,
      });

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location != null) {
        if (hop === MAX_REDIRECTS) {
          return {
            ...base,
            result: 'failed',
            httpStatus: response.status,
            error: `More than ${MAX_REDIRECTS} redirects`,
            message: `Unsubscribe from ${request.senderLabel} failed: too many redirects.`,
          };
        }
        url = new URL(location, url).toString();
        continue;
      }
      break;
    }

    const status = response?.status ?? 0;
    if (status >= 200 && status < 300) {
      return {
        ...base,
        result: 'success',
        httpStatus: status,
        message: `Unsubscribed from ${request.senderLabel} (one-click, HTTP ${status}).`,
      };
    }
    return {
      ...base,
      result: 'failed',
      httpStatus: status,
      error: `HTTP ${status}`,
      message: `Unsubscribe from ${request.senderLabel} failed with HTTP ${status}.`,
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    return {
      ...base,
      result: 'failed',
      error,
      message: `Unsubscribe from ${request.senderLabel} failed: ${error}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A link is opened in the browser and the sender is marked `pending_manual`.
 *
 * Deliberately not fetched. Many unsubscribe links are GET-triggered actions;
 * many more lead to a preference centre that needs input; and some are tracking
 * pixels whose only function is to confirm to a spammer that the address is
 * live. Silently fetching one can therefore do nothing, do the wrong thing, or
 * do harm — so a person looks at it.
 */
async function manualLink(
  request: ExecuteRequest,
  deps: ExecuteDependencies,
  base: AttemptBase,
): Promise<UnsubscribeAttempt> {
  try {
    await deps.openBrowser(request.uri);
    return {
      ...base,
      result: 'pending_manual',
      message:
        `Opened the unsubscribe page for ${request.senderLabel} in your browser. ` +
        "It's marked pending — I'll ask whether it worked on your next review.",
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    return {
      ...base,
      result: 'pending_manual',
      error,
      message:
        `Could not open a browser for ${request.senderLabel}. ` +
        `Open this yourself: ${request.uri}`,
    };
  }
}

/** `mailto:` — compose and send through the authenticated account. */
async function mailto(
  request: ExecuteRequest,
  deps: ExecuteDependencies,
  base: AttemptBase,
): Promise<UnsubscribeAttempt> {
  const parsed = parseMailto(request.uri);
  if (parsed === undefined) {
    return {
      ...base,
      result: 'failed',
      error: 'Unparseable mailto URI',
      message: `Could not read the unsubscribe address for ${request.senderLabel}.`,
    };
  }

  const send = deps.provider?.send;
  if (send === undefined) {
    return {
      ...base,
      result: 'failed',
      error: 'Provider cannot send mail',
      message:
        `${request.senderLabel} unsubscribes by email, but this mail source cannot ` +
        `send. Send a message to ${parsed.to} yourself.`,
    };
  }

  try {
    const sent = await send.call(deps.provider, parsed);
    return {
      ...base,
      result: 'success',
      sentMessageId: sent.messageId,
      message: `Sent an unsubscribe email to ${parsed.to} for ${request.senderLabel}.`,
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    return {
      ...base,
      result: 'failed',
      error,
      message: `Could not send the unsubscribe email for ${request.senderLabel}: ${error}`,
    };
  }
}

export interface MailtoParts {
  to: string;
  subject: string;
  body: string;
}

/**
 * Read a `mailto:` URI, honouring its `subject` and `body` parameters.
 *
 * List software frequently requires an exact subject — `unsubscribe`,
 * `leave discuss` — and ignores anything else. Discarding the parameters would
 * produce a message the far end silently drops.
 */
export function parseMailto(uri: string): MailtoParts | undefined {
  if (!/^mailto:/i.test(uri)) return undefined;

  const withoutScheme = uri.slice('mailto:'.length);
  const questionMark = withoutScheme.indexOf('?');
  const to = decodeURIComponent(
    (questionMark === -1 ? withoutScheme : withoutScheme.slice(0, questionMark)).trim(),
  );
  if (to.length === 0 || !to.includes('@')) return undefined;

  const params = new URLSearchParams(
    questionMark === -1 ? '' : withoutScheme.slice(questionMark + 1),
  );

  return {
    to,
    subject: params.get('subject') ?? 'unsubscribe',
    body: params.get('body') ?? 'unsubscribe',
  };
}

/** Days after which continued mail is worth flagging (CAN-SPAM's window). */
export const STILL_SENDING_DAYS = 10;

/**
 * Is this sender still sending after an unsubscribe?
 *
 * Useful on its own, and legally meaningful: CAN-SPAM gives a sender ten
 * business days to honour an opt-out.
 */
export function isStillSending(
  attemptedAt: Date,
  lastReceivedAt: Date,
  days: number = STILL_SENDING_DAYS,
): boolean {
  return lastReceivedAt.getTime() > attemptedAt.getTime() + days * 86_400_000;
}
