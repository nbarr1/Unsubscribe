import type { UnsubscribeMethod } from '../detection/detect.js';
import type { DecisionRecord } from '../domain/decisions.js';
import type { AggregatedSender } from '../domain/review.js';
import type { Db } from './db.js';

/**
 * Read queries for the interface layer.
 *
 * The aggregation lives in SQL and the rules live in the domain layer; nothing
 * in `src/cli` writes a query.
 */

interface AggregateRow {
  sender_id: string;
  display_name: string | null;
  display_address: string | null;
  message_count: number;
  first_seen: string;
  last_seen: string;
  method: string | null;
  confidence: number | null;
  unsubscribe_uri: string | null;
  suspicious: number | null;
}

/**
 * Aggregate every sender that has at least one message with a signal.
 *
 * The "best" method per sender is the highest-confidence one, and its URI is
 * the most recent message using that method — the rule the product states for
 * senders whose messages disagree. Merged-away senders are excluded; their
 * messages already moved to the surviving sender.
 */
const AGGREGATE_SQL = `
  WITH best AS (
    SELECT
      sender_id, method, confidence, unsubscribe_uri, suspicious,
      ROW_NUMBER() OVER (
        PARTITION BY sender_id
        ORDER BY confidence DESC, received_at DESC, id DESC
      ) AS rank
    FROM message
  )
  SELECT
    s.id                AS sender_id,
    s.display_name      AS display_name,
    s.display_address   AS display_address,
    COUNT(m.id)         AS message_count,
    MIN(m.received_at)  AS first_seen,
    MAX(m.received_at)  AS last_seen,
    b.method            AS method,
    b.confidence        AS confidence,
    b.unsubscribe_uri   AS unsubscribe_uri,
    b.suspicious        AS suspicious
  FROM sender s
  JOIN message m ON m.sender_id = s.id
  LEFT JOIN best b ON b.sender_id = s.id AND b.rank = 1
  WHERE s.merged_into IS NULL
  GROUP BY s.id
`;

function toAggregate(row: AggregateRow): AggregatedSender {
  return {
    senderId: row.sender_id,
    displayName: row.display_name,
    displayAddress: row.display_address,
    messageCount: row.message_count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    method: (row.method as UnsubscribeMethod | null) ?? null,
    confidence: row.confidence ?? 0,
    unsubscribeUri: row.unsubscribe_uri,
    suspicious: row.suspicious === 1,
  };
}

export function aggregatedSenders(db: Db): AggregatedSender[] {
  return db.prepare<[], AggregateRow>(AGGREGATE_SQL).all().map(toAggregate);
}

export function aggregatedSender(db: Db, senderId: string): AggregatedSender | undefined {
  const row = db
    .prepare<[string], AggregateRow>(`${AGGREGATE_SQL} HAVING s.id = ?`)
    .get(senderId);
  return row === undefined ? undefined : toAggregate(row);
}

/**
 * Every decision, grouped by sender.
 *
 * The whole log rather than just the latest row: the projection needs the
 * history to answer "why is this back?", and at six sessions a year the log is
 * kilobytes.
 */
export function decisionsBySender(db: Db): Map<string, DecisionRecord[]> {
  const rows = db
    .prepare<[], Record<string, unknown>>(
      'SELECT * FROM decision ORDER BY sender_id, decided_at ASC, id ASC',
    )
    .all();

  const grouped = new Map<string, DecisionRecord[]>();
  for (const row of rows) {
    const record: DecisionRecord = {
      id: row['id'] as number,
      senderId: row['sender_id'] as string,
      decision: row['decision'] as DecisionRecord['decision'],
      decidedAt: row['decided_at'] as string,
      suppressedUntil: (row['suppressed_until'] as string | null) ?? null,
      note: (row['note'] as string | null) ?? undefined,
    };
    const existing = grouped.get(record.senderId);
    if (existing === undefined) grouped.set(record.senderId, [record]);
    else existing.push(record);
  }
  return grouped;
}

/**
 * Resolve a user-supplied sender reference.
 *
 * Accepts a sender id or id prefix, an address, a List-ID, or a substring of
 * the display name — because nobody is going to type a UUID at a prompt.
 */
export function findSenders(db: Db, reference: string): AggregatedSender[] {
  const needle = reference.trim().toLowerCase();
  if (needle.length === 0) return [];

  const ids = new Set<string>();

  for (const row of db
    .prepare<[string], { id: string }>(
      "SELECT id FROM sender WHERE lower(id) LIKE ? || '%'",
    )
    .all(needle)) {
    ids.add(row.id);
  }

  for (const row of db
    .prepare<[string], { sender_id: string }>(
      'SELECT sender_id FROM sender_identity WHERE lower(value) = ?',
    )
    .all(needle)) {
    ids.add(row.sender_id);
  }

  for (const row of db
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM sender
        WHERE lower(COALESCE(display_name, '')) LIKE '%' || ? || '%'
           OR lower(COALESCE(display_address, '')) LIKE '%' || ? || '%'`,
    )
    .all(needle, needle)) {
    ids.add(row.id);
  }

  const found: AggregatedSender[] = [];
  for (const id of ids) {
    // Follow a merge, so a reference to a merged-away sender finds the survivor.
    const surviving =
      db
        .prepare<[string], { merged_into: string | null }>(
          'SELECT merged_into FROM sender WHERE id = ?',
        )
        .get(id)?.merged_into ?? id;
    const aggregate = aggregatedSender(db, surviving);
    if (aggregate !== undefined && !found.some((f) => f.senderId === surviving)) {
      found.push(aggregate);
    }
  }
  return found;
}

export interface UnsubscribeAttemptRow {
  id: number;
  senderId: string;
  method: UnsubscribeMethod;
  attemptedAt: string;
  result: 'success' | 'pending_manual' | 'failed' | 'skipped_suspicious';
  httpStatus: number | null;
  targetUri: string | null;
  sentMessageId: string | null;
  error: string | null;
}

export function attemptsForSender(db: Db, senderId: string): UnsubscribeAttemptRow[] {
  return db
    .prepare<[string], Record<string, unknown>>(
      'SELECT * FROM unsubscribe_attempt WHERE sender_id = ? ORDER BY attempted_at ASC, id ASC',
    )
    .all(senderId)
    .map((row) => ({
      id: row['id'] as number,
      senderId: row['sender_id'] as string,
      method: row['method'] as UnsubscribeMethod,
      attemptedAt: row['attempted_at'] as string,
      result: row['result'] as UnsubscribeAttemptRow['result'],
      httpStatus: (row['http_status'] as number | null) ?? null,
      targetUri: (row['target_uri'] as string | null) ?? null,
      sentMessageId: (row['sent_message_id'] as string | null) ?? null,
      error: (row['error'] as string | null) ?? null,
    }));
}

/** Latest attempt per sender, for the follow-up section of `review`. */
export function latestAttempts(db: Db): Map<string, UnsubscribeAttemptRow> {
  const latest = new Map<string, UnsubscribeAttemptRow>();
  const rows = db
    .prepare<[], { sender_id: string }>(
      'SELECT DISTINCT sender_id FROM unsubscribe_attempt',
    )
    .all();
  for (const { sender_id: senderId } of rows) {
    const attempts = attemptsForSender(db, senderId);
    const last = attempts.at(-1);
    if (last !== undefined) latest.set(senderId, last);
  }
  return latest;
}
