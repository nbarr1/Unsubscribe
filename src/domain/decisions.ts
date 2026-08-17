import type { Clock } from './clock.js';
import {
  applyDuration,
  daysUntil,
  formatDate,
  parseInstant,
  toIso,
  type Duration,
} from './time.js';

/**
 * The decision log and its projection (ADR-006).
 *
 * Decisions are appended, never updated. Everything the user sees about
 * suppression — is this sender hidden, when does it come back, why is it back —
 * is computed here from the log at read time. Nothing about suppression is
 * stored as mutable state, which is what makes "why is this sender back?"
 * answerable four months later.
 */

export type DecisionKind = 'keep' | 'unsubscribe' | 'unsuppress';

export interface DecisionRecord {
  /** Monotonic, used to break ties when two decisions share a timestamp. */
  id: number;
  senderId: string;
  decision: DecisionKind;
  /** UTC ISO-8601. */
  decidedAt: string;
  /** UTC ISO-8601, or `null` meaning "never resurface". Only set on `keep`. */
  suppressedUntil: string | null;
  note?: string | undefined;
}

/** The default hold. Three months is a floor, not a ceiling (ADR-006). */
export const DEFAULT_KEEP_DURATION: Duration = { months: 3 };

export interface KeepInput {
  senderId: string;
  duration?: Duration | undefined;
  note?: string | undefined;
}

/**
 * Build the `decision` row for a Keep. Storage appends what this returns; it
 * does not compute dates of its own.
 */
export function buildKeepDecision(
  input: KeepInput,
  clock: Clock,
): Omit<DecisionRecord, 'id'> {
  const now = clock.now();
  const until = applyDuration(now, input.duration ?? DEFAULT_KEEP_DURATION);
  return {
    senderId: input.senderId,
    decision: 'keep',
    decidedAt: toIso(now),
    suppressedUntil: until === null ? null : toIso(until),
    note: input.note,
  };
}

export function buildUnsubscribeDecision(
  senderId: string,
  clock: Clock,
  note?: string,
): Omit<DecisionRecord, 'id'> {
  return {
    senderId,
    decision: 'unsubscribe',
    decidedAt: toIso(clock.now()),
    suppressedUntil: null,
    note,
  };
}

/**
 * Ending a hold early is an appended event, not a deletion. The Keep it
 * overrides stays in the log, so the answer to "why is this back?" is still
 * "you kept it on the 12th and unsuppressed it on the 20th".
 */
export function buildUnsuppressDecision(
  senderId: string,
  clock: Clock,
  note?: string,
): Omit<DecisionRecord, 'id'> {
  return {
    senderId,
    decision: 'unsuppress',
    decidedAt: toIso(clock.now()),
    suppressedUntil: null,
    note,
  };
}

/** The latest decision for a sender: newest `decidedAt`, then highest `id`. */
export function latestDecision(
  decisions: readonly DecisionRecord[],
): DecisionRecord | undefined {
  let latest: DecisionRecord | undefined;
  for (const decision of decisions) {
    if (latest === undefined) {
      latest = decision;
      continue;
    }
    const a = parseInstant(decision.decidedAt).getTime();
    const b = parseInstant(latest.decidedAt).getTime();
    if (a > b || (a === b && decision.id > latest.id)) latest = decision;
  }
  return latest;
}

export type SuppressionStatus =
  /** Never decided on. Shows in review as a new sender. */
  | { state: 'never_decided' }
  /** Kept, hold still running. Hidden from review. */
  | {
      state: 'suppressed';
      decidedAt: Date;
      until: Date;
      daysRemaining: number;
    }
  /** Kept with `--forever`. Hidden from review indefinitely. */
  | { state: 'suppressed_forever'; decidedAt: Date }
  /** Kept, but the hold has expired. Shows in review tagged as returning. */
  | { state: 'returning'; decidedAt: Date; expiredAt: Date }
  /** Unsubscribed. Not a review candidate; tracked for `still_sending`. */
  | { state: 'unsubscribed'; decidedAt: Date }
  /** A hold was ended early by hand. Shows in review. */
  | { state: 'unsuppressed'; decidedAt: Date };

/**
 * Project the log onto the sender's current suppression state.
 *
 * Expiry is computed here, against the injected clock — a hold does not "run
 * out" as a write that something has to remember to perform. It runs out
 * because the clock moved. That is why nothing needs to run between sessions.
 */
export function suppressionStatus(
  decisions: readonly DecisionRecord[],
  clock: Clock,
): SuppressionStatus {
  const latest = latestDecision(decisions);
  if (latest === undefined) return { state: 'never_decided' };

  const decidedAt = parseInstant(latest.decidedAt);

  switch (latest.decision) {
    case 'unsubscribe':
      return { state: 'unsubscribed', decidedAt };
    case 'unsuppress':
      return { state: 'unsuppressed', decidedAt };
    case 'keep': {
      if (latest.suppressedUntil === null) {
        return { state: 'suppressed_forever', decidedAt };
      }
      const until = parseInstant(latest.suppressedUntil);
      const now = clock.now();
      if (until.getTime() > now.getTime()) {
        return {
          state: 'suppressed',
          decidedAt,
          until,
          daysRemaining: daysUntil(now, until),
        };
      }
      return { state: 'returning', decidedAt, expiredAt: until };
    }
  }
}

/** Should this sender appear in the review list? */
export function isReviewable(status: SuppressionStatus): boolean {
  switch (status.state) {
    case 'never_decided':
    case 'returning':
    case 'unsuppressed':
      return true;
    case 'suppressed':
    case 'suppressed_forever':
    case 'unsubscribed':
      return false;
  }
}

/** Is this sender hidden *because it was kept*? Drives the review footer count. */
export function isHiddenByKeep(status: SuppressionStatus): boolean {
  return status.state === 'suppressed' || status.state === 'suppressed_forever';
}

/* ---------------------------------------------------------------------------
 * Legibility (ADR-006, non-negotiable).
 *
 * These strings are product requirements, not interface decoration, so they
 * live in the domain layer where they can be tested against a fast-forwarded
 * clock rather than eyeballed in a terminal.
 * ------------------------------------------------------------------------ */

/** `Keeping Patagonia. Won't ask again until Nov 17, 2026.` */
export function keepConfirmation(
  displayName: string,
  decision: Pick<DecisionRecord, 'suppressedUntil'>,
): string {
  if (decision.suppressedUntil === null) {
    return `Keeping ${displayName}. Won't ask again.`;
  }
  const until = parseInstant(decision.suppressedUntil);
  return `Keeping ${displayName}. Won't ask again until ${formatDate(until)}.`;
}

/** `Returns in 47 days (Oct 3, 2026)` — the `kept` view. */
export function returnDescription(status: SuppressionStatus): string {
  if (status.state === 'suppressed_forever') return 'Never returns (kept forever)';
  if (status.state !== 'suppressed') return 'Returns now';
  const { daysRemaining, until } = status;
  const noun = daysRemaining === 1 ? 'day' : 'days';
  if (daysRemaining <= 0) return `Returns today (${formatDate(until)})`;
  return `Returns in ${daysRemaining} ${noun} (${formatDate(until)})`;
}

/**
 * `Returning — you kept this on May 12, 2026; the 3-month hold has expired.`
 *
 * The hold length is described from the log, not from today's default: a hold
 * given as 6 months keeps saying "6-month hold" even if the default changes.
 */
export function returningTag(status: SuppressionStatus): string | undefined {
  if (status.state !== 'returning') return undefined;
  const length = describeHoldLength(status.decidedAt, status.expiredAt);
  return `Returning — you kept this on ${formatDate(status.decidedAt)}; the ${length} hold has expired.`;
}

function describeHoldLength(from: Date, to: Date): string {
  const days = daysUntil(from, to);
  const months = Math.round(days / 30.44);
  if (months >= 12 && months % 12 === 0) {
    const years = months / 12;
    return years === 1 ? '1-year' : `${years}-year`;
  }
  if (months >= 1) return `${months}-month`;
  return `${days}-day`;
}

/**
 * The review footer. **Always present**, including at zero, because "no senders
 * are hidden" is exactly as important to state as "12 are" — an absent footer
 * is indistinguishable from a footer the tool forgot to render.
 */
export function hiddenFooter(hiddenCount: number): string {
  if (hiddenCount === 0) {
    return 'No senders hidden. Run `unsub kept` to see past decisions.';
  }
  const noun = hiddenCount === 1 ? 'sender' : 'senders';
  return (
    `${hiddenCount} ${noun} hidden — kept within the last 3 months. ` +
    "Run 'unsub kept' to see them and their return dates."
  );
}
