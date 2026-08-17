import { returnDescription, type SuppressionStatus } from '../domain/decisions.js';
import {
  methodLabel,
  senderLabel,
  type KeptSender,
  type ReviewList,
  type ReviewSender,
} from '../domain/review.js';
import { formatDate, parseInstant } from '../domain/time.js';

/**
 * Terminal rendering.
 *
 * Plain strings, no colour libraries, no table dependency. The legibility
 * requirements are all text, and text is the part of this tool most likely to
 * still render correctly in four years.
 */

export function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : text.slice(0, width - 1) + '…';
}

/**
 * A fixed-width cell that always ends in at least one space.
 *
 * Truncating to the full width lets a long address butt straight up against
 * the next column, and `…9` reads as part of the address rather than as the
 * message count.
 */
function column(text: string, width: number): string {
  return padEnd(truncate(text, width - 1), width);
}

/** The review table: volume first, because that is what makes triage worth it. */
export function renderReviewTable(senders: readonly ReviewSender[]): string {
  if (senders.length === 0) return '  Nothing to review.';

  const widths = { index: 4, name: 28, address: 34, count: 6, last: 13, method: 10 };
  const lines: string[] = [];

  lines.push(
    '  ' +
      column('#', widths.index) +
      column('Sender', widths.name) +
      column('Address', widths.address) +
      column('Msgs', widths.count) +
      column('Last seen', widths.last) +
      column('Method', widths.method),
  );
  lines.push('  ' + '─'.repeat(Object.values(widths).reduce((a, b) => a + b, 0)));

  senders.forEach((sender, index) => {
    lines.push(
      '  ' +
        column(String(index + 1), widths.index) +
        column(senderLabel(sender), widths.name) +
        column(sender.displayAddress ?? '', widths.address) +
        column(String(sender.messageCount), widths.count) +
        column(formatDate(parseInstant(sender.lastSeen)), widths.last) +
        column(
          methodLabel(sender.method) + (sender.suspicious ? ' ⚠' : ''),
          widths.method,
        ),
    );
    // The returning tag is a whole sentence and gets its own line: it is the
    // answer to "why is this back?", which is not a column.
    if (sender.returningTag !== undefined) {
      lines.push('      ' + sender.returningTag);
    }
  });

  return lines.join('\n');
}

export function renderReview(list: ReviewList): string {
  const parts = [renderReviewTable(list.senders), '', '  ' + list.footer];
  if (list.senders.some((s) => s.suspicious)) {
    parts.push(
      '  ⚠ marks a sender whose unsubscribe link points at an unrelated domain. ' +
        'These are never actioned without --confirm-suspicious.',
    );
  }
  return parts.join('\n');
}

/** The kept view: what is hidden, and exactly when each returns. */
export function renderKept(kept: readonly KeptSender[]): string {
  if (kept.length === 0) {
    return '  No senders are currently kept. Nothing is hidden from your review list.';
  }

  const lines: string[] = [];
  for (const sender of kept) {
    lines.push(`  ${senderLabel(sender)}`);
    lines.push(`    ${sender.displayAddress ?? ''}`.trimEnd());
    lines.push(
      `    ${returnDescription(sender.status)} — kept on ${formatDate(sender.status.decidedAt)}`,
    );
    lines.push(`    ${sender.messageCount} messages in the window`);
    lines.push('');
  }
  lines.push(
    `  ${kept.length} sender${kept.length === 1 ? '' : 's'} hidden from review.`,
  );
  return lines.join('\n');
}

/** One-line description of a sender's suppression state, for `status`. */
export function describeStatus(status: SuppressionStatus): string {
  switch (status.state) {
    case 'never_decided':
      return 'never decided on';
    case 'suppressed':
      return `kept on ${formatDate(status.decidedAt)}; ${returnDescription(status).toLowerCase()}`;
    case 'suppressed_forever':
      return `kept forever on ${formatDate(status.decidedAt)}`;
    case 'returning':
      return `kept on ${formatDate(status.decidedAt)}; hold expired ${formatDate(status.expiredAt)}`;
    case 'unsubscribed':
      return `unsubscribed on ${formatDate(status.decidedAt)}`;
    case 'unsuppressed':
      return `hold ended early on ${formatDate(status.decidedAt)}`;
  }
}

/**
 * A progress line that overwrites itself.
 *
 * Without this the first `review` of a session looks hung, and a tool that
 * looks hung gets killed (ADR-002).
 */
export function renderProgress(
  folder: string,
  examined: number,
  detected: number,
  total: number,
): string {
  const ratio = total > 0 ? Math.min(1, examined / total) : 0;
  const filled = Math.round(ratio * 24);
  const bar = '█'.repeat(filled) + '░'.repeat(24 - filled);
  return `  ${bar} ${folder}: ${examined}/${total || '?'} scanned, ${detected} with unsubscribe`;
}
