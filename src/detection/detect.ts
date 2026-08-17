import { registrableDomain } from '../domain/normalize.js';
import {
  dkimDomains,
  header,
  headerAll,
  htmlPart,
  parseAddress,
  type Headers,
  type MessagePart,
} from './mime.js';
import { matchPreferenceToken, matchUnsubscribeToken, matchUrlToken } from './tokens.js';

/**
 * Unsubscribe detection.
 *
 * Four tiers, highest confidence first. Tiers 1–3 read headers only and cost
 * nothing beyond the fetch that already happened; tier 4 is the only one that
 * requires a full body, and is therefore only reached when the headers yielded
 * nothing at all.
 */

export type UnsubscribeMethod = 'one_click' | 'http_link' | 'mailto' | 'body_link';

export interface Detection {
  method: UnsubscribeMethod;
  uri: string;
  /**
   * 0–1. Used to pick a winner when one sender's messages disagree, and shown
   * to the user so a low-confidence body scrape is visibly a guess.
   */
  confidence: number;
  /** Which rule fired, for the UI and for debugging a wrong answer. */
  evidence: string;
  /**
   * The unsubscribe target's registrable domain matches neither the `From`
   * domain nor any DKIM `d=` domain. Correlates with phishing and list-washing.
   */
  suspicious: boolean;
}

export const CONFIDENCE: Record<UnsubscribeMethod, number> = {
  // RFC 8058. The only method safe to execute automatically.
  one_click: 1.0,
  // RFC 2369 https URI. A link, not a one-click.
  http_link: 0.8,
  mailto: 0.7,
  // Scraped from the body. Always a guess.
  body_link: 0.4,
};

/** A body link found via a preference-centre phrase, not an unsubscribe one. */
const PREFERENCE_LINK_CONFIDENCE = 0.3;

/** Everything the detector needs about a message. */
export interface DetectableMessage {
  headers: Headers;
  /** Decoded body parts. Empty when only headers were fetched (the common case). */
  parts?: readonly MessagePart[] | undefined;
}

/**
 * Parse a `List-Unsubscribe` header into its URIs (RFC 2369).
 *
 * The value is a comma-separated list of angle-bracketed URIs. Anything not in
 * angle brackets is not a URI per the RFC, but real senders emit bare URLs, so
 * those are accepted too rather than losing the signal.
 */
export function parseListUnsubscribe(value: string): string[] {
  const uris: string[] = [];
  const bracketed = /<([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = bracketed.exec(value)) !== null) {
    const uri = (match[1] ?? '').trim();
    if (uri.length > 0) uris.push(uri);
  }
  if (uris.length === 0) {
    for (const part of value.split(',')) {
      const uri = part.trim();
      if (/^(https?|mailto):/i.test(uri)) uris.push(uri);
    }
  }
  return uris;
}

/**
 * Does `List-Unsubscribe-Post` opt this message into RFC 8058 one-click?
 *
 * The RFC defines exactly one value. Anything else is not one-click, and
 * guessing would mean POSTing to a URL that never agreed to receive one.
 */
export function hasOneClickPost(headers: Headers): boolean {
  const value = header(headers, 'list-unsubscribe-post');
  if (value === undefined) return false;
  return value.trim().toLowerCase().replace(/\s+/g, '') === 'list-unsubscribe=one-click';
}

export interface Anchor {
  href: string;
  text: string;
  title?: string | undefined;
  ariaLabel?: string | undefined;
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

/**
 * Pull anchors out of an HTML body.
 *
 * A regex rather than a DOM parser: the need is four attributes off `<a>` tags
 * in mail HTML, and a full HTML5 parser is a large dependency to carry — and to
 * keep current — for that. Malformed markup degrades to fewer matches, which
 * costs a tier-4 detection, not a wrong one.
 */
export function extractAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = [];
  let match: RegExpExecArray | null;
  ANCHOR.lastIndex = 0;
  while ((match = ANCHOR.exec(html)) !== null) {
    const attributes = match[1] ?? '';
    const href = attribute(attributes, 'href');
    if (href === undefined || href.length === 0) continue;
    anchors.push({
      href: decodeEntities(href),
      text: stripTags(match[2] ?? ''),
      title: attribute(attributes, 'title'),
      ariaLabel: attribute(attributes, 'aria-label'),
    });
  }
  return anchors;
}

function attribute(attributes: string, name: string): string | undefined {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attributes);
  if (quoted !== null) return (quoted[1] ?? '').trim();
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(attributes);
  return bare !== null ? (bare[1] ?? '').trim() : undefined;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** Tier 4: find the best unsubscribe-looking anchor in an HTML body. */
export function detectBodyLink(
  html: string,
): { uri: string; confidence: number; evidence: string } | undefined {
  let best: { uri: string; confidence: number; evidence: string } | undefined;

  for (const anchor of extractAnchors(html)) {
    if (!/^https?:/i.test(anchor.href)) continue;

    const surfaces: Array<[string, string]> = [
      ['link text', anchor.text],
      ['title', anchor.title ?? ''],
      ['aria-label', anchor.ariaLabel ?? ''],
    ];

    let found: { confidence: number; evidence: string } | undefined;

    for (const [surface, value] of surfaces) {
      const strong = matchUnsubscribeToken(value);
      if (strong !== undefined) {
        found = {
          confidence: CONFIDENCE.body_link,
          evidence: `body anchor ${surface} matched "${strong}"`,
        };
        break;
      }
    }

    if (found === undefined) {
      const urlToken = matchUrlToken(anchor.href);
      if (urlToken !== undefined) {
        found = {
          confidence: CONFIDENCE.body_link,
          evidence: `body anchor URL matched "${urlToken}"`,
        };
      }
    }

    if (found === undefined) {
      for (const [surface, value] of surfaces) {
        const weak = matchPreferenceToken(value);
        if (weak !== undefined) {
          found = {
            confidence: PREFERENCE_LINK_CONFIDENCE,
            evidence: `body anchor ${surface} matched preference phrase "${weak}"`,
          };
          break;
        }
      }
    }

    if (found === undefined) continue;
    if (best === undefined || found.confidence > best.confidence) {
      best = { uri: anchor.href, ...found };
    }
  }

  return best;
}

/**
 * Is this unsubscribe target plausibly the sender's own?
 *
 * Compares registrable domains: the target's against the `From` domain and
 * against every DKIM `d=` domain. A mismatch is not proof of anything — plenty
 * of legitimate senders unsubscribe through their ESP's domain — which is why
 * it sets a flag for the user rather than blocking anything on its own.
 */
export function isSuspicious(
  targetUri: string,
  fromAddress: string,
  dkim: readonly string[],
): boolean {
  const target = targetDomain(targetUri);
  if (target === undefined) return false;

  const from = registrableDomain(fromAddress);
  if (from !== undefined && from === target) return false;

  return !dkim.some((domain) => registrableDomain(domain) === target);
}

function targetDomain(uri: string): string | undefined {
  if (/^mailto:/i.test(uri)) {
    const address = uri.slice('mailto:'.length).split('?')[0] ?? '';
    return registrableDomain(address);
  }
  try {
    return registrableDomain(new URL(uri).hostname);
  } catch {
    return undefined;
  }
}

/**
 * Detect the highest-confidence unsubscribe signal on a message.
 *
 * Returns `undefined` when there is none. When `parts` is absent — the normal
 * case, because ADR-001 fetches headers only — tier 4 simply does not run, and
 * `needsBody` on the result of {@link headersInconclusive} tells the sync
 * engine whether fetching the body is worth it.
 */
export function detect(message: DetectableMessage): Detection | undefined {
  const { headers } = message;
  const from = parseAddress(header(headers, 'from')).address;
  const dkim = dkimDomains(headers);

  const finish = (
    method: UnsubscribeMethod,
    uri: string,
    confidence: number,
    evidence: string,
  ): Detection => ({
    method,
    uri,
    confidence,
    evidence,
    suspicious: isSuspicious(uri, from, dkim),
  });

  const listUnsubscribe = headerAll(headers, 'list-unsubscribe').join(', ');
  const uris = listUnsubscribe.length > 0 ? parseListUnsubscribe(listUnsubscribe) : [];
  const https = uris.find((uri) => /^https:/i.test(uri));
  const http = uris.find((uri) => /^https?:/i.test(uri));
  const mailto = uris.find((uri) => /^mailto:/i.test(uri));

  // Tier 1 — RFC 8058 one-click. Requires BOTH the Post header and an https
  // URI: a one-click POST to an http URL would leak the opt-out in the clear,
  // and the RFC requires https.
  if (https !== undefined && hasOneClickPost(headers)) {
    return finish(
      'one_click',
      https,
      CONFIDENCE.one_click,
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click with an https URI (RFC 8058)',
    );
  }

  // Tier 2 — an http(s) URI in List-Unsubscribe (RFC 2369). A link, not a
  // one-click: it is opened in the browser, never fetched silently.
  if (http !== undefined) {
    return finish(
      'http_link',
      http,
      CONFIDENCE.http_link,
      'https URI in List-Unsubscribe (RFC 2369)',
    );
  }

  // Tier 3 — mailto.
  if (mailto !== undefined) {
    return finish('mailto', mailto, CONFIDENCE.mailto, 'mailto URI in List-Unsubscribe');
  }

  // Tier 4 — body scrape. Only reached with a body in hand.
  const html = htmlPart(message.parts ?? []);
  if (html !== undefined) {
    const found = detectBodyLink(html);
    if (found !== undefined) {
      return finish('body_link', found.uri, found.confidence, found.evidence);
    }
  }

  return undefined;
}

/**
 * Would fetching the full body be worth it?
 *
 * True only when the headers produced nothing. This is the gate that keeps
 * ADR-001's "headers only" promise: a full body is fetched for a message only
 * after the cheap tiers have all failed on it.
 */
export function headersInconclusive(headers: Headers): boolean {
  return detect({ headers }) === undefined;
}
