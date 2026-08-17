import { randomUUID } from 'node:crypto';

import type { Clock } from '../domain/clock.js';
import type { DecisionRecord } from '../domain/decisions.js';
import type { Identity, IdentityMatch } from '../domain/identity.js';
import { toIso } from '../domain/time.js';
import type { UnsubscribeMethod } from '../detection/detect.js';
import type { Db } from './db.js';

/**
 * Storage-side repositories.
 *
 * All SQL lives here. The domain layer stays pure and the CLI never sees a
 * query. `better-sqlite3` is synchronous and is used synchronously (ADR-004).
 */

export interface SenderRow {
  id: string;
  displayName: string | null;
  displayAddress: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  mergedInto: string | null;
}

export interface MessageInput {
  id: string;
  senderId: string;
  folder: string;
  uidvalidity: number;
  uid: number;
  receivedAt: string;
  subject?: string | undefined;
  fromName?: string | undefined;
  fromAddress: string;
  listId?: string | undefined;
  method: UnsubscribeMethod;
  confidence: number;
  unsubscribeUri?: string | undefined;
  suspicious: boolean;
}

export class SenderRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Find which senders already own any of these identities. */
  findMatches(candidates: readonly Identity[]): IdentityMatch[] {
    if (candidates.length === 0) return [];
    const statement = this.db.prepare<[string, string], { sender_id: string }>(
      'SELECT sender_id FROM sender_identity WHERE kind = ? AND value = ?',
    );
    const matches: IdentityMatch[] = [];
    for (const identity of candidates) {
      for (const row of statement.all(identity.kind, identity.value)) {
        matches.push({ identity, senderId: this.resolveMergeTarget(row.sender_id) });
      }
    }
    return matches;
  }

  /**
   * Follow `merged_into` to the surviving sender.
   *
   * A merged-away sender keeps its row and its identities so history stays
   * readable, but everything new lands on the target.
   */
  resolveMergeTarget(senderId: string): string {
    let current = senderId;
    // Bounded: a merge chain longer than this is a bug, not a deep hierarchy.
    for (let hops = 0; hops < 32; hops += 1) {
      const row = this.db
        .prepare<[string], { merged_into: string | null }>(
          'SELECT merged_into FROM sender WHERE id = ?',
        )
        .get(current);
      if (row?.merged_into == null) return current;
      current = row.merged_into;
    }
    return current;
  }

  create(init: {
    displayName?: string | undefined;
    displayAddress?: string | undefined;
    seenAt: string;
  }): string {
    const id = randomUUID();
    const now = toIso(this.clock.now());
    this.db
      .prepare(
        `INSERT INTO sender
           (id, display_name, display_address, first_seen_at, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        init.displayName ?? null,
        init.displayAddress ?? null,
        init.seenAt,
        init.seenAt,
        now,
      );
    return id;
  }

  addIdentities(senderId: string, identities: readonly Identity[], seenAt: string): void {
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO sender_identity (sender_id, kind, value, first_seen_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const identity of identities) {
      statement.run(senderId, identity.kind, identity.value, seenAt);
    }
  }

  /**
   * Refresh the display cache and the seen window.
   *
   * These are caches, never identity (ADR-005): the display name follows the
   * most recent message so a sender that rebrands shows its current name.
   */
  touch(
    senderId: string,
    seenAt: string,
    display: { name?: string | undefined; address?: string | undefined },
  ): void {
    this.db
      .prepare(
        `UPDATE sender
            SET first_seen_at = MIN(first_seen_at, ?),
                last_seen_at  = MAX(last_seen_at, ?),
                display_name    = COALESCE(?, display_name),
                display_address = COALESCE(?, display_address)
          WHERE id = ?`,
      )
      .run(seenAt, seenAt, display.name ?? null, display.address ?? null, senderId);
  }

  get(senderId: string): SenderRow | undefined {
    const row = this.db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM sender WHERE id = ?')
      .get(senderId);
    return row === undefined ? undefined : toSenderRow(row);
  }

  identitiesOf(senderId: string): Identity[] {
    return this.db
      .prepare<[string], { kind: string; value: string }>(
        'SELECT kind, value FROM sender_identity WHERE sender_id = ? ORDER BY kind, value',
      )
      .all(senderId)
      .map((r) => ({ kind: r.kind as Identity['kind'], value: r.value }));
  }

  /**
   * Merge `sourceId` into `targetId`, recording the merge so it can be replayed
   * after a normalisation rule change (ADR-005).
   */
  merge(sourceId: string, targetId: string, note?: string): void {
    if (sourceId === targetId) return;
    const now = toIso(this.clock.now());
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sender_merge (source_id, target_id, merged_at, active, note)
           VALUES (?, ?, ?, 1, ?)`,
        )
        .run(sourceId, targetId, now, note ?? null);
      this.db
        .prepare('UPDATE sender SET merged_into = ? WHERE id = ?')
        .run(targetId, sourceId);
      this.db
        .prepare('UPDATE message SET sender_id = ? WHERE sender_id = ?')
        .run(targetId, sourceId);
    })();
  }

  /**
   * Undo a merge. Appends a deactivating row rather than deleting, so the
   * history of what the user decided about grouping is itself append-only.
   */
  unmerge(sourceId: string, note?: string): void {
    const now = toIso(this.clock.now());
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE sender_merge SET active = 0
            WHERE source_id = ? AND active = 1`,
        )
        .run(sourceId);
      this.db
        .prepare(
          `INSERT INTO sender_merge (source_id, target_id, merged_at, active, note)
           SELECT source_id, target_id, ?, 0, ?
             FROM sender_merge WHERE source_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .run(now, note ?? 'split', sourceId);
      this.db.prepare('UPDATE sender SET merged_into = NULL WHERE id = ?').run(sourceId);
    })();
  }

  /** Every merge the user has authored, for replay after a rule change. */
  activeMerges(): Array<{ sourceId: string; targetId: string }> {
    return this.db
      .prepare<[], { source_id: string; target_id: string }>(
        `SELECT source_id, target_id FROM sender_merge
          WHERE active = 1 ORDER BY id ASC`,
      )
      .all()
      .map((r) => ({ sourceId: r.source_id, targetId: r.target_id }));
  }

  /**
   * Re-apply every user-authored merge.
   *
   * Run after any change to the normalisation rules. A `merge` command whose
   * result does not survive re-normalisation is a trap (ADR-005), so this is
   * what makes it not one.
   */
  replayMerges(): number {
    const merges = this.activeMerges();
    for (const { sourceId, targetId } of merges) {
      const target = this.resolveMergeTarget(targetId);
      if (target === sourceId) continue;
      this.db
        .prepare('UPDATE sender SET merged_into = ? WHERE id = ?')
        .run(target, sourceId);
      this.db
        .prepare('UPDATE message SET sender_id = ? WHERE sender_id = ?')
        .run(target, sourceId);
    }
    return merges.length;
  }
}

function toSenderRow(row: Record<string, unknown>): SenderRow {
  return {
    id: row['id'] as string,
    displayName: (row['display_name'] as string | null) ?? null,
    displayAddress: (row['display_address'] as string | null) ?? null,
    firstSeenAt: row['first_seen_at'] as string,
    lastSeenAt: row['last_seen_at'] as string,
    mergedInto: (row['merged_into'] as string | null) ?? null,
  };
}

export class MessageRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Record a message, ignoring one already recorded.
   *
   * This is what makes sync idempotent (ADR-002). The primary key is the
   * Message-ID where the sender provided one, so the same message seen through
   * two folders — Gmail's INBOX and All Mail, say — is one row, not two.
   * Message counts are then `COUNT(*)` queries rather than maintained counters,
   * so there is no counter that a re-run could double.
   */
  record(input: MessageInput): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO message
           (id, sender_id, folder, uidvalidity, uid, received_at, subject, from_name,
            from_address, list_id, method, confidence, unsubscribe_uri, suspicious,
            ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.senderId,
        input.folder,
        input.uidvalidity,
        input.uid,
        input.receivedAt,
        input.subject ?? null,
        input.fromName ?? null,
        input.fromAddress,
        input.listId ?? null,
        input.method,
        input.confidence,
        input.unsubscribeUri ?? null,
        input.suspicious ? 1 : 0,
        toIso(this.clock.now()),
      );
    return result.changes > 0;
  }

  countForSender(senderId: string): number {
    return (
      this.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM message WHERE sender_id = ?',
        )
        .get(senderId)?.n ?? 0
    );
  }

  total(): number {
    return (
      this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM message').get()?.n ??
      0
    );
  }
}

export class DecisionRepository {
  constructor(private readonly db: Db) {}

  append(decision: Omit<DecisionRecord, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO decision (sender_id, decision, decided_at, suppressed_until, note)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        decision.senderId,
        decision.decision,
        decision.decidedAt,
        decision.suppressedUntil,
        decision.note ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  /** Every decision for a sender, oldest first. Nothing is ever deleted. */
  forSender(senderId: string): DecisionRecord[] {
    return this.db
      .prepare<[string], Record<string, unknown>>(
        'SELECT * FROM decision WHERE sender_id = ? ORDER BY decided_at ASC, id ASC',
      )
      .all(senderId)
      .map(toDecisionRecord);
  }

  /**
   * The latest decision for every sender, in one query.
   *
   * The review projection needs this for the whole mailbox at once; doing it
   * per sender would be a query per row.
   */
  latestPerSender(): Map<string, DecisionRecord> {
    const rows = this.db
      .prepare<[], Record<string, unknown>>(
        `SELECT d.* FROM decision d
           JOIN (
             SELECT sender_id, MAX(decided_at) AS m
               FROM decision GROUP BY sender_id
           ) latest
             ON latest.sender_id = d.sender_id AND latest.m = d.decided_at
          ORDER BY d.id ASC`,
      )
      .all();

    const byId = new Map<string, DecisionRecord>();
    for (const row of rows) {
      const record = toDecisionRecord(row);
      // Rows are ordered by id, so a later row wins a same-timestamp tie.
      byId.set(record.senderId, record);
    }
    return byId;
  }
}

function toDecisionRecord(row: Record<string, unknown>): DecisionRecord {
  return {
    id: row['id'] as number,
    senderId: row['sender_id'] as string,
    decision: row['decision'] as DecisionRecord['decision'],
    decidedAt: row['decided_at'] as string,
    suppressedUntil: (row['suppressed_until'] as string | null) ?? null,
    note: (row['note'] as string | null) ?? undefined,
  };
}

export interface Watermark {
  folder: string;
  uidvalidity: number;
  lastUid: number;
  lastSyncedAt: string;
  backfillSince: string | null;
}

export class SyncStateRepository {
  constructor(private readonly db: Db) {}

  get(folder: string): Watermark | undefined {
    const row = this.db
      .prepare<[string], Record<string, unknown>>(
        'SELECT * FROM sync_state WHERE folder = ?',
      )
      .get(folder);
    if (row === undefined) return undefined;
    return {
      folder: row['folder'] as string,
      uidvalidity: row['uidvalidity'] as number,
      lastUid: row['last_uid'] as number,
      lastSyncedAt: row['last_synced_at'] as string,
      backfillSince: (row['backfill_since'] as string | null) ?? null,
    };
  }

  save(watermark: Watermark): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (folder, uidvalidity, last_uid, last_synced_at, backfill_since)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (folder) DO UPDATE SET
           uidvalidity    = excluded.uidvalidity,
           last_uid       = excluded.last_uid,
           last_synced_at = excluded.last_synced_at,
           backfill_since = excluded.backfill_since`,
      )
      .run(
        watermark.folder,
        watermark.uidvalidity,
        watermark.lastUid,
        watermark.lastSyncedAt,
        watermark.backfillSince,
      );
  }

  /**
   * Discard a folder's watermark because `UIDVALIDITY` changed.
   *
   * Every UID recorded for this folder is now meaningless (ADR-001). The
   * messages themselves are kept — they are keyed by Message-ID, so a resync
   * re-attaches them rather than duplicating them.
   */
  reset(folder: string): void {
    this.db.prepare('DELETE FROM sync_state WHERE folder = ?').run(folder);
  }

  all(): Watermark[] {
    return this.db
      .prepare<[], { folder: string }>('SELECT folder FROM sync_state ORDER BY folder')
      .all()
      .flatMap((r) => {
        const watermark = this.get(r.folder);
        return watermark === undefined ? [] : [watermark];
      });
  }
}
