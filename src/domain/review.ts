import type { UnsubscribeMethod } from '../detection/detect.js';
import type { Clock } from './clock.js';
import {
  hiddenFooter,
  isHiddenByKeep,
  isReviewable,
  returningTag,
  suppressionStatus,
  type DecisionRecord,
  type SuppressionStatus,
} from './decisions.js';
import { parseInstant } from './time.js';

/**
 * The review projection (ADR-006).
 *
 * Pure: it takes aggregated sender rows and the decision log, and produces what
 * the interface renders. The suppression rules live in `decisions.ts`; this
 * module's job is to apply them to a whole mailbox and to carry the legibility
 * requirements — hidden count, returning tags — as data rather than as strings
 * assembled in a render loop.
 */

/** One sender, aggregated across its messages. */
export interface AggregatedSender {
  senderId: string;
  displayName: string | null;
  displayAddress: string | null;
  messageCount: number;
  firstSeen: string;
  lastSeen: string;
  /** Highest-confidence method across this sender's messages. */
  method: UnsubscribeMethod | null;
  confidence: number;
  /** Most recent URI for that method. */
  unsubscribeUri: string | null;
  suspicious: boolean;
}

export interface ReviewSender extends AggregatedSender {
  status: SuppressionStatus;
  /** Set when the sender is back after a hold expired. */
  returningTag?: string | undefined;
}

export interface ReviewList {
  senders: ReviewSender[];
  /** Senders hidden because they were kept. Drives the footer. */
  hiddenByKeep: number;
  /**
   * The footer, always present. "No senders are hidden" is exactly as
   * important to state as "12 are": an absent footer is indistinguishable from
   * a footer the tool forgot to render.
   */
  footer: string;
}

export interface ReviewOptions {
  /** Show suppressed senders too, tagged with their status. */
  includeSuppressed?: boolean | undefined;
  limit?: number | undefined;
}

/**
 * Build the review list.
 *
 * Senders are sorted by volume, which is what makes the list worth triaging:
 * the sender that sent 90 messages is the one worth a decision.
 */
export function buildReview(
  senders: readonly AggregatedSender[],
  decisionsBySender: ReadonlyMap<string, readonly DecisionRecord[]>,
  clock: Clock,
  options: ReviewOptions = {},
): ReviewList {
  const all: ReviewSender[] = senders.map((sender) => {
    const status = suppressionStatus(decisionsBySender.get(sender.senderId) ?? [], clock);
    return { ...sender, status, returningTag: returningTag(status) };
  });

  const hiddenByKeep = all.filter((s) => isHiddenByKeep(s.status)).length;

  let visible =
    options.includeSuppressed === true ? all : all.filter((s) => isReviewable(s.status));

  visible = visible.sort(byVolumeThenRecency);

  if (options.limit !== undefined) visible = visible.slice(0, options.limit);

  return { senders: visible, hiddenByKeep, footer: hiddenFooter(hiddenByKeep) };
}

function byVolumeThenRecency(a: ReviewSender, b: ReviewSender): number {
  if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
  return parseInstant(b.lastSeen).getTime() - parseInstant(a.lastSeen).getTime();
}

export interface KeptSender extends ReviewSender {
  status: Extract<SuppressionStatus, { state: 'suppressed' | 'suppressed_forever' }>;
}

/**
 * The kept view: every sender currently hidden by a Keep, soonest to return
 * first — which is the order the user cares about, since it is the order they
 * will see them again.
 */
export function buildKept(
  senders: readonly AggregatedSender[],
  decisionsBySender: ReadonlyMap<string, readonly DecisionRecord[]>,
  clock: Clock,
): KeptSender[] {
  const kept: KeptSender[] = [];
  for (const sender of senders) {
    const status = suppressionStatus(decisionsBySender.get(sender.senderId) ?? [], clock);
    if (status.state === 'suppressed' || status.state === 'suppressed_forever') {
      kept.push({ ...sender, status });
    }
  }
  return kept.sort((a, b) => {
    // A forever-keep never returns, so it sorts last rather than at day zero.
    const aDays = a.status.state === 'suppressed' ? a.status.daysRemaining : Infinity;
    const bDays = b.status.state === 'suppressed' ? b.status.daysRemaining : Infinity;
    return aDays - bDays;
  });
}

/** How a sender is described in a list: display name, falling back sensibly. */
export function senderLabel(sender: AggregatedSender): string {
  if (sender.displayName != null && sender.displayName.length > 0) {
    return sender.displayName;
  }
  if (sender.displayAddress != null && sender.displayAddress.length > 0) {
    return sender.displayAddress;
  }
  return sender.senderId.slice(0, 8);
}

/** Human-readable method name for the review table. */
export function methodLabel(method: UnsubscribeMethod | null): string {
  switch (method) {
    case 'one_click':
      return 'one-click';
    case 'http_link':
      return 'link';
    case 'mailto':
      return 'mailto';
    case 'body_link':
      return 'body link';
    case null:
      return 'none';
  }
}
