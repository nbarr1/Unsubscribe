import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestClock } from '../../src/domain/clock.js';
import { FakeMailProvider, type FakeMessage } from '../../src/providers/fake.js';
import { openDatabase, type Db } from '../../src/storage/db.js';
import { SenderRepository } from '../../src/storage/repository.js';
import { SyncEngine } from '../../src/sync/engine.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function eml(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.eml`), 'utf8');
}

function message(name: string, uid: number, date: string): FakeMessage {
  return { raw: eml(name), uid, internalDate: new Date(date) };
}

const INBOX = [
  message('tier1-one-click', 1, '2026-08-10T16:14:20Z'),
  message('tier2-http-link', 2, '2026-08-11T06:02:11Z'),
  message('tier3-mailto', 3, '2026-08-12T12:00:00Z'),
  message('tier4-body-link', 4, '2026-08-13T08:30:00Z'),
  message('no-signal', 5, '2026-08-17T11:04:00Z'),
  message('verp-rotating-sender', 6, '2026-08-14T07:00:00Z'),
  message('verp-rotating-sender-2', 7, '2026-08-21T07:00:00Z'),
];

function provider(messages: FakeMessage[] = INBOX, uidValidity = 42): FakeMailProvider {
  // Copy: `addMessage` mutates the folder's list, and a shared fixture array
  // would leak new mail from one test into every test after it.
  return FakeMailProvider.from({ INBOX: { uidValidity, messages: [...messages] } });
}

describe('sync engine (ADR-002)', () => {
  let dir: string;
  let db: Db;
  let clock: TestClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'unsub-sync-'));
    db = openDatabase({ path: join(dir, 'sync.db') });
    clock = new TestClock('2026-08-22T09:00:00Z');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function rows(table: string): number {
    return (
      db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0
    );
  }

  describe('ingest', () => {
    it('records only messages that carry an unsubscribe signal', () => {
      const mail = provider();
      const engine = new SyncEngine(db, mail, clock);
      return engine.sync({ scrapeBodies: true }).then((result) => {
        expect(result.interrupted).toBe(false);
        // Six of the seven have a signal; the personal message does not, even
        // though its prose mentions unsubscribing.
        expect(result.recorded).toBe(6);
        expect(rows('message')).toBe(6);
      });
    });

    it('folds a rotating VERP sender into one sender record', async () => {
      const engine = new SyncEngine(db, provider(), clock);
      await engine.sync({ scrapeBodies: true });

      const senders = db
        .prepare<[], { id: string; display_address: string }>(
          'SELECT id, display_address FROM sender',
        )
        .all();
      const verp = senders.filter((s) =>
        s.display_address.includes('bounce.mailer.test'),
      );
      expect(verp).toHaveLength(1);

      const messages = new SenderRepository(db, clock);
      expect(messages.identitiesOf(verp[0]?.id ?? '')).toContainEqual({
        kind: 'normalized_key',
        value: 'addr:bounce-*@bounce.mailer.test',
      });
    });

    it('carries the detection result onto the message row', async () => {
      const engine = new SyncEngine(db, provider(), clock);
      await engine.sync({ scrapeBodies: true });

      const methods = db
        .prepare<[], { method: string; n: number }>(
          'SELECT method, COUNT(*) AS n FROM message GROUP BY method',
        )
        .all();
      expect(Object.fromEntries(methods.map((m) => [m.method, m.n]))).toEqual({
        one_click: 1,
        http_link: 3,
        mailto: 1,
        body_link: 1,
      });
    });
  });

  describe('the headers-only promise (ADR-001)', () => {
    it('fetches no bodies at all when body scraping is off', async () => {
      const mail = provider();
      await new SyncEngine(db, mail, clock).sync({ scrapeBodies: false });
      expect(mail.bodyFetches).toEqual([]);
    });

    it('fetches a body only for messages the headers could not settle', async () => {
      const mail = provider();
      await new SyncEngine(db, mail, clock).sync({ scrapeBodies: true });
      // Only the tier-4 fixture and the personal message have no header signal.
      expect(mail.bodyFetches.map((f) => f.uid).sort()).toEqual([4, 5]);
    });
  });

  describe('idempotency — running sync twice', () => {
    it('produces no duplicate rows', async () => {
      const mail = provider();
      const engine = new SyncEngine(db, mail, clock);

      await engine.sync({ scrapeBodies: true });
      const afterFirst = {
        messages: rows('message'),
        senders: rows('sender'),
        identities: rows('sender_identity'),
      };

      await engine.sync({ scrapeBodies: true });

      expect({
        messages: rows('message'),
        senders: rows('sender'),
        identities: rows('sender_identity'),
      }).toEqual(afterFirst);
    });

    it('produces no duplicates even when the watermark is discarded', async () => {
      // Forcing a full rescan is the harshest idempotency test: every message
      // is re-examined from scratch.
      const mail = provider();
      const engine = new SyncEngine(db, mail, clock);
      await engine.sync({ scrapeBodies: true });
      const before = rows('message');

      db.prepare('DELETE FROM sync_state').run();
      await engine.sync({ scrapeBodies: true });

      expect(rows('message')).toBe(before);
    });

    it('does not double-count a sender message count', async () => {
      const mail = provider();
      const engine = new SyncEngine(db, mail, clock);
      await engine.sync({ scrapeBodies: true });
      await engine.sync({ scrapeBodies: true });
      await engine.sync({ scrapeBodies: true });

      const counts = db
        .prepare<[], { n: number }>(
          'SELECT COUNT(*) AS n FROM message GROUP BY sender_id',
        )
        .all()
        .map((r) => r.n);
      // The VERP sender has two messages; every other sender has one.
      expect(counts.sort()).toEqual([1, 1, 1, 1, 2]);
    });

    it('re-syncs only what is new on a second run', async () => {
      const mail = provider();
      const engine = new SyncEngine(db, mail, clock);
      await engine.sync({ scrapeBodies: true });

      mail.addMessage('INBOX', message('list-id-grouping', 8, '2026-08-15T06:00:00Z'));
      const second = await engine.sync({ scrapeBodies: true });

      expect(second.examined).toBe(1);
      expect(second.recorded).toBe(1);
      expect(rows('message')).toBe(7);
    });
  });

  describe('resumability — killing sync mid-run', () => {
    it('keeps what it committed and produces no duplicates on re-run', async () => {
      const mail = provider();
      const engine = new SyncEngine(db, mail, clock);

      // Die partway through. With interruption being the common case for an
      // on-demand tool, this is the path that has to be safe.
      mail.failAfterMessages = 3;
      const killed = await engine.sync({ scrapeBodies: true });
      expect(killed.interrupted).toBe(true);
      expect(killed.error?.message).toContain('simulated interruption');

      mail.resume();
      const resumed = await engine.sync({ scrapeBodies: true });
      expect(resumed.interrupted).toBe(false);

      expect(rows('message')).toBe(6);
      const ids = db
        .prepare<[], { id: string }>('SELECT id FROM message')
        .all()
        .map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('reaches the same state as an uninterrupted run', async () => {
      const interrupted = provider();
      const engineA = new SyncEngine(db, interrupted, clock);
      interrupted.failAfterMessages = 2;
      await engineA.sync({ scrapeBodies: true });
      interrupted.resume();
      interrupted.failAfterMessages = 5;
      await engineA.sync({ scrapeBodies: true });
      interrupted.resume();
      await engineA.sync({ scrapeBodies: true });

      const clean = openDatabase({ path: join(dir, 'clean.db') });
      try {
        await new SyncEngine(clean, provider(), clock).sync({ scrapeBodies: true });

        const summarise = (database: Db): unknown =>
          database
            .prepare<[], unknown>(
              `SELECT from_address, method, confidence, suspicious
                 FROM message ORDER BY id`,
            )
            .all();

        expect(summarise(db)).toEqual(summarise(clean));
      } finally {
        clean.close();
      }
    });

    it('never advances the watermark past a message it did not store', async () => {
      const mail = provider();
      const engine = new SyncEngine(db, mail, clock);
      mail.failAfterMessages = 3;
      await engine.sync({ scrapeBodies: true });

      const watermark = db
        .prepare<[], { last_uid: number }>('SELECT last_uid FROM sync_state')
        .get();
      const highestStored = db
        .prepare<[], { u: number | null }>('SELECT MAX(uid) AS u FROM message')
        .get();

      expect(watermark?.last_uid ?? 0).toBeLessThanOrEqual(highestStored?.u ?? 0);
    });
  });

  describe('UIDVALIDITY (ADR-001)', () => {
    it('discards the watermark and resyncs when it changes', async () => {
      const mail = provider();
      const engine = new SyncEngine(db, mail, clock);
      await engine.sync({ scrapeBodies: true });

      mail.setUidValidity('INBOX', 99);
      const result = await engine.sync({ scrapeBodies: true });

      expect(result.folders[0]?.uidValidityChanged).toBe(true);
      expect(result.examined).toBe(INBOX.length);
    });

    it('does not duplicate messages across the resync', async () => {
      // Messages are keyed by Message-ID, so a resync re-attaches them.
      const mail = provider();
      const engine = new SyncEngine(db, mail, clock);
      await engine.sync({ scrapeBodies: true });
      const before = rows('message');

      mail.setUidValidity('INBOX', 99);
      await engine.sync({ scrapeBodies: true });

      expect(rows('message')).toBe(before);
      expect(
        db
          .prepare<[], { uidvalidity: number }>(
            'SELECT DISTINCT uidvalidity FROM message',
          )
          .all(),
      ).toEqual([{ uidvalidity: 42 }]);
    });

    it('stores the new UIDVALIDITY on the watermark', async () => {
      const mail = provider();
      const engine = new SyncEngine(db, mail, clock);
      await engine.sync({ scrapeBodies: true });
      mail.setUidValidity('INBOX', 99);
      await engine.sync({ scrapeBodies: true });

      expect(
        db
          .prepare<[], { uidvalidity: number }>('SELECT uidvalidity FROM sync_state')
          .get()?.uidvalidity,
      ).toBe(99);
    });
  });

  describe('the backfill window (ADR-002)', () => {
    it('ignores messages older than the window', async () => {
      const mail = provider([
        message('tier1-one-click', 1, '2020-01-01T00:00:00Z'),
        message('tier2-http-link', 2, '2026-08-11T06:02:11Z'),
      ]);
      const result = await new SyncEngine(db, mail, clock).sync({});
      expect(result.examined).toBe(1);
    });

    it('goes back further when a later run widens --since', async () => {
      const mail = provider([
        message('tier1-one-click', 1, '2024-01-01T00:00:00Z'),
        message('tier2-http-link', 2, '2026-08-11T06:02:11Z'),
      ]);
      const engine = new SyncEngine(db, mail, clock);

      await engine.sync({});
      expect(rows('message')).toBe(1);

      await engine.sync({ since: new Date('2023-01-01T00:00:00Z') });
      expect(rows('message')).toBe(2);
    });

    it('advances the watermark for a folder where nothing matched', async () => {
      // Otherwise every future run rescans the whole folder from scratch.
      const mail = provider([message('no-signal', 1, '2026-08-17T11:04:00Z')]);
      const engine = new SyncEngine(db, mail, clock);
      await engine.sync({ scrapeBodies: true });

      expect(
        db.prepare<[], { last_uid: number }>('SELECT last_uid FROM sync_state').get()
          ?.last_uid,
      ).toBe(1);

      const second = await engine.sync({ scrapeBodies: true });
      expect(second.examined).toBe(0);
    });
  });

  describe('progress reporting', () => {
    it('reports progress, so the first review of a session does not look hung', async () => {
      const seen: string[] = [];
      await new SyncEngine(db, provider(), clock).sync({
        scrapeBodies: true,
        onProgress: (p) => seen.push(p.phase),
      });
      expect(seen.filter((p) => p === 'scanning').length).toBe(INBOX.length);
      expect(seen.at(-1)).toBe('folder-complete');
    });
  });

  describe('multiple folders', () => {
    it('tracks a watermark per folder', async () => {
      const mail = FakeMailProvider.from({
        INBOX: {
          uidValidity: 1,
          messages: [message('tier1-one-click', 1, '2026-08-10T00:00:00Z')],
        },
        Archive: {
          uidValidity: 2,
          messages: [message('tier2-http-link', 9, '2026-08-11T00:00:00Z')],
        },
      });
      await new SyncEngine(db, mail, clock).sync({});

      const watermarks = db
        .prepare<[], { folder: string; uidvalidity: number; last_uid: number }>(
          'SELECT folder, uidvalidity, last_uid FROM sync_state ORDER BY folder',
        )
        .all();
      expect(watermarks).toEqual([
        { folder: 'Archive', uidvalidity: 2, last_uid: 9 },
        { folder: 'INBOX', uidvalidity: 1, last_uid: 1 },
      ]);
    });

    it('stores the same message seen in two folders once', async () => {
      const mail = FakeMailProvider.from({
        INBOX: {
          uidValidity: 1,
          messages: [message('tier1-one-click', 1, '2026-08-10T00:00:00Z')],
        },
        'All Mail': {
          uidValidity: 2,
          messages: [message('tier1-one-click', 5, '2026-08-10T00:00:00Z')],
        },
      });
      await new SyncEngine(db, mail, clock).sync({});
      expect(rows('message')).toBe(1);
    });
  });
});
