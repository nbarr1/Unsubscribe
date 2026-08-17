import { getDomain } from 'tldts';

import {
  ALLOW_PRIVATE_SUFFIXES,
  BOUNCE_PREFIXES,
  SEGMENT_DELIMITERS,
  SUBADDRESS_SEPARATOR,
  VARIABLE_SEGMENT_THRESHOLDS,
  type VariableSegmentThresholds,
} from './normalization-rules.js';

/**
 * Normalisation, per ADR-005. Pure functions over strings — no I/O, no clock.
 *
 * The output feeds `normalized_key` identity rows. It is never a primary key
 * and nothing foreign-keys to it, which is exactly what lets these rules change
 * without orphaning a decision.
 */

/** Rules can be overridden per call so a test can prove a rule change is safe. */
export interface NormalizationRules {
  thresholds: VariableSegmentThresholds;
  bouncePrefixes: readonly string[];
  allowPrivateSuffixes: boolean;
}

export const DEFAULT_RULES: NormalizationRules = {
  thresholds: VARIABLE_SEGMENT_THRESHOLDS,
  bouncePrefixes: BOUNCE_PREFIXES,
  allowPrivateSuffixes: ALLOW_PRIVATE_SUFFIXES,
};

/**
 * Split an address into local part and domain, lowercased and trimmed.
 * Returns `undefined` for anything that is not recognisably an address.
 */
export function splitAddress(
  address: string,
): { local: string; domain: string } | undefined {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return undefined;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (local.length === 0 || domain.length === 0 || !domain.includes('.')) {
    return undefined;
  }
  return { local, domain };
}

/** The registrable domain, via the Public Suffix List — not a two-label split. */
export function registrableDomain(
  hostOrAddressOrUrl: string,
  rules: NormalizationRules = DEFAULT_RULES,
): string | undefined {
  const input = hostOrAddressOrUrl.trim().toLowerCase();
  const subject = input.includes('@') ? (splitAddress(input)?.domain ?? input) : input;
  const domain = getDomain(subject, {
    allowPrivateDomains: rules.allowPrivateSuffixes,
  });
  return domain ?? undefined;
}

const HEX = /^[0-9a-f]+$/;
const DIGITS = /^\d+$/;
const HAS_DIGIT = /\d/;
const ALNUM = /^[0-9a-z]+$/;

/** Does this local-part segment look machine-generated rather than named? */
export function isVariableSegment(
  segment: string,
  thresholds: VariableSegmentThresholds = VARIABLE_SEGMENT_THRESHOLDS,
): boolean {
  if (segment.length === 0) return false;
  if (DIGITS.test(segment)) return segment.length >= thresholds.digits;
  if (HEX.test(segment) && segment.length >= thresholds.hex) return true;
  if (ALNUM.test(segment) && HAS_DIGIT.test(segment)) {
    return segment.length >= thresholds.mixed;
  }
  return false;
}

/**
 * Strip subaddressing and collapse VERP-style variable segments.
 *
 * `bounce-12345-abc@example.com` → `bounce-*-abc@example.com`
 * `you+shopping@example.com`     → `you@example.com`
 *
 * Returns the normalised address and whether anything was actually collapsed —
 * the caller uses that to decide whether this address is a rotating one.
 */
export function normalizeLocalPart(
  local: string,
  rules: NormalizationRules = DEFAULT_RULES,
): { normalized: string; collapsed: boolean } {
  const tagIndex = local.indexOf(SUBADDRESS_SEPARATOR);
  const withoutTag = tagIndex > 0 ? local.slice(0, tagIndex) : local;

  const parts = withoutTag.split(SEGMENT_DELIMITERS);
  const delimiters = withoutTag.match(new RegExp(SEGMENT_DELIMITERS, 'g')) ?? [];

  const first = parts[0] ?? '';
  const isBounce = rules.bouncePrefixes.includes(first);

  let collapsed = tagIndex > 0;
  const normalizedParts = parts.map((segment, index) => {
    // Everything after a recognised bounce prefix is envelope machinery.
    if (isBounce && index > 0) {
      if (segment.length > 0) collapsed = true;
      return '*';
    }
    if (isVariableSegment(segment, rules.thresholds)) {
      collapsed = true;
      return '*';
    }
    return segment;
  });

  // Reassemble with the original delimiters so `bounce-*` stays distinct from
  // `bounce.*`, then squash runs of `*` that a multi-segment id produced.
  let normalized = normalizedParts[0] ?? '';
  for (let i = 1; i < normalizedParts.length; i += 1) {
    normalized += (delimiters[i - 1] ?? '-') + (normalizedParts[i] ?? '');
  }
  normalized = normalized.replace(/(?:[-+_.=]\*){2,}$/, '-*');

  return { normalized, collapsed };
}

/**
 * Normalise a `List-ID` header value to its bare list identity.
 *
 * `List-ID: "Patagonia News" <news.patagonia.com>` → `news.patagonia.com`
 */
export function normalizeListId(headerValue: string): string | undefined {
  const raw = headerValue.trim();
  if (raw.length === 0) return undefined;
  // Angle brackets are authoritative when present, even when what they contain
  // is empty — `<>` is a malformed header, not a list called "<>".
  const bracketed = /<([^>]*)>/.exec(raw);
  const value = (bracketed?.[1] ?? raw).trim().toLowerCase();
  // A bare List-ID with no angle brackets may still carry a quoted phrase.
  const cleaned = value.replace(/^"(.*)"$/, '$1').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export interface NormalizationInput {
  /** Raw `List-ID` header value, if the message had one. */
  listId?: string | undefined;
  /** The `From` address, as it appeared. */
  fromAddress: string;
}

export type NormalizationTier = 'list_id' | 'address' | 'domain';

export interface NormalizedKey {
  /** The identity value stored as a `normalized_key` row. */
  key: string;
  /** Which rule produced it — surfaced in the UI, since tier 3 is a guess. */
  tier: NormalizationTier;
}

/**
 * Compute the `normalized_key` identity for a message (ADR-005).
 *
 * The tiers, in order:
 *   1. `List-ID` — the sender's own statement of which list this is.
 *   2. The `From` address with subaddressing stripped and VERP segments
 *      collapsed.
 *   3. The registrable domain — a **last resort**. `notifications@github.com`
 *      and `noreply@github.com` are different subscriptions to a person, and
 *      this tier folds them together, so it only applies when the address
 *      itself is too variable to be an identity.
 *
 * The key is prefixed with its tier so two tiers can never collide: a list
 * literally named `example.com` must not be the same identity as the domain
 * `example.com`.
 */
export function normalizedKey(
  input: NormalizationInput,
  rules: NormalizationRules = DEFAULT_RULES,
): NormalizedKey | undefined {
  if (input.listId !== undefined) {
    const listId = normalizeListId(input.listId);
    if (listId !== undefined) return { key: `list:${listId}`, tier: 'list_id' };
  }

  const parts = splitAddress(input.fromAddress);
  if (parts === undefined) return undefined;

  const { normalized, collapsed } = normalizeLocalPart(parts.local, rules);

  // Tier 3 only when the address has no stable part left to identify it by.
  // `bounce-*@` is still a usable identity: it is stable across recipients and
  // it keeps this sender separate from others on the same domain.
  const nothingStableLeft = normalized.replace(/[-+_.=*]/g, '').length === 0;
  if (collapsed && nothingStableLeft) {
    const domain = registrableDomain(parts.domain, rules);
    if (domain !== undefined) return { key: `domain:${domain}`, tier: 'domain' };
  }

  return { key: `addr:${normalized}@${parts.domain}`, tier: 'address' };
}
