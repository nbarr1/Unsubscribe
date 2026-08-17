import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  kept,
  keepDurationFrom,
  merge,
  review,
  status,
  unsuppress,
  type Io,
} from '../../src/cli/commands.js';
import { createContext, type Context } from '../../src/cli/context.js';
import { TestClock } from '../../src/domain/clock.js';
import { FakeMailProvider } from '../../src/providers/fake.js';
import { MemoryCredentialStore } from '../../src/providers/credentials.js';
import { openDatabase, type Db } from '../../src/storage/db.js';
import { aggregatedSenders, decisionsBySender } from '../../src/storage/queries.js';
import { buildReview } from '../../src/domain/review.js';
import { withTimeZone } from '../helpers/timezone.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function message(name: string, uid: number, date: string) {
  return {
    raw: readFileSync(join(FIXTURES, `${name}.eml`), 'utf8'),
    uid,
    internalDate: new Date(date),
  };
}

/** A scripted terminal: canned answers in, captured output out. */
class ScriptedIo implements Io {
  readonly lines: string[] = [];

  constructor(private readonly answers: string[] = []) {}

  out(line: string): void {
    // Commands emit whole blocks; the tests reason about rows.
    for (const part of line.split('\n')) this.lines.push(part);
  }

  progress(): void {
    // Nothing: a progress bar is not part of what a test asserts.
  }

  async prompt(): Promise<string> {
    return this.answers.shift() ?? 'quit';
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

/** The order `review` presents senders in, which is what the user acts on. */
function reviewOrder(db: Db, clock: TestClock) {
  return buildReview(aggregatedSenders(db), decisionsBySender(db), clock, {
    includeSuppressed: true,
  }).senders;
}

describe('cli flow', () => {
  let dir: string;
  let db: Db;
  let clock: TestClock;
  let mail: FakeMailProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'unsub-cli-'));
    db = openDatabase({ path: join(dir, 'cli.db') });
    clock = new TestClock('2026-08-22T09:00:00Z');
    mail = FakeMailProvider.from({
      INBOX: {
        uidValidity: 7,
        messages: [
          message('tier1-one-click', 1, '2026-08-10T16:14:20Z'),
          message('tier2-http-link', 2, '2026-08-11T06:02:11Z'),
          message('tier3-mailto', 3, '2026-08-12T12:00:00Z'),
          message('verp-rotating-sender', 4, '2026-08-14T07:00:00Z'),
          message('verp-rotating-sender-2', 5, '2026-08-21T07:00:00Z'),
          message('suspicious-domain', 6, '2026-08-16T22:41:03Z'),
        ],
      },
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function context(): Context {
    return createContext({
      db,
      clock,
      provider: mail,
      credentials: new MemoryCredentialStore(),
      env: {
        UNSUB_DATA_DIR: dir,
        UNSUB_IMAP_HOST: 'imap.test',
        UNSUB_IMAP_USER: 'you@test',
      },
    });
  }

  it('goes from an empty database to a review list', async () => {
    const io = new ScriptedIo();
    await review(context(), { listOnly: true }, io);

    expect(io.text).toContain('Patagonia');
    expect(io.text).toContain('Weekly Roundup');
    // Sorted by volume: the VERP sender has two messages, everything else one.
    const table = io.lines.filter((l) => /^\s+\d+\s{2,}/.test(l));
    expect(table[0]).toContain('Weekly Roundup');
  });

  it('shows the method and marks a suspicious target', async () => {
    const io = new ScriptedIo();
    await review(context(), { listOnly: true }, io);
    expect(io.text).toContain('one-click');
    expect(io.text).toContain('mailto');
    expect(io.text).toContain('⚠');
    expect(io.text).toContain('never actioned without --confirm-suspicious');
  });

  describe('the legibility requirements', () => {
    it('always shows the footer, including when nothing is hidden', async () => {
      const io = new ScriptedIo();
      await review(context(), { listOnly: true }, io);
      expect(io.text).toContain('No senders hidden');
    });

    it('confirms a Keep with a concrete date', async () => {
      await withTimeZone('UTC', async () => {
        const io = new ScriptedIo(['keep', 'quit']);
        await review(context(), {}, io);
        expect(io.text).toContain("Won't ask again until Nov 22, 2026.");
      });
    });

    it('counts hidden senders in the footer after a Keep', async () => {
      const io = new ScriptedIo(['keep', 'quit']);
      await review(context(), {}, io);

      const second = new ScriptedIo();
      await review(context(), { noSync: true, listOnly: true }, second);
      expect(second.text).toContain(
        "1 sender hidden — kept within the last 3 months. Run 'unsub kept' to see them and their return dates.",
      );
    });

    it('shows return dates in the kept view', async () => {
      await withTimeZone('UTC', async () => {
        const io = new ScriptedIo(['keep', 'quit']);
        await review(context(), {}, io);

        clock.set('2026-10-06T09:00:00Z');
        const keptIo = new ScriptedIo();
        kept(context(), keptIo);

        expect(keptIo.text).toContain('Returns in 47 days (Nov 22, 2026)');
        expect(keptIo.text).toContain('kept on Aug 22, 2026');
      });
    });

    it('tags a sender that comes back after its hold expires', async () => {
      await withTimeZone('UTC', async () => {
        const io = new ScriptedIo(['keep', 'quit']);
        await review(context(), {}, io);

        clock.set('2026-11-23T09:00:00Z');
        const later = new ScriptedIo();
        await review(context(), { noSync: true, listOnly: true }, later);

        expect(later.text).toContain(
          'Returning — you kept this on Aug 22, 2026; the 3-month hold has expired.',
        );
      });
    });

    it('says plainly when nothing is kept', () => {
      const io = new ScriptedIo();
      kept(context(), io);
      expect(io.text).toContain('Nothing is hidden from your review list');
    });
  });

  describe('suppression', () => {
    it('removes a kept sender from the next review list', async () => {
      const before = new ScriptedIo();
      await review(context(), { listOnly: true }, before);
      const beforeCount = before.lines.filter((l) => /^\s+\d+\s{2,}/.test(l)).length;

      const io = new ScriptedIo(['keep', 'quit']);
      await review(context(), {}, io);

      const after = new ScriptedIo();
      await review(context(), { noSync: true, listOnly: true }, after);
      const afterCount = after.lines.filter((l) => /^\s+\d+\s{2,}/.test(l)).length;

      expect(afterCount).toBe(beforeCount - 1);
    });

    it('brings a sender back with --include-suppressed', async () => {
      const io = new ScriptedIo(['keep', 'quit']);
      await review(context(), {}, io);

      const all = new ScriptedIo();
      await review(
        context(),
        { noSync: true, listOnly: true, includeSuppressed: true },
        all,
      );
      expect(all.lines.filter((l) => /^\s+\d+\s{2,}/.test(l))).toHaveLength(5);
    });

    it('honours a longer hold', async () => {
      await withTimeZone('UTC', async () => {
        const io = new ScriptedIo(['keep', 'quit']);
        await review(context(), { keepDuration: keepDurationFrom('6m', undefined) }, io);
        expect(io.text).toContain("Won't ask again until Feb 22, 2027.");
      });
    });

    it('honours --forever', async () => {
      const io = new ScriptedIo(['keep', 'quit']);
      await review(context(), { keepDuration: keepDurationFrom(undefined, true) }, io);
      expect(io.text).toContain("Won't ask again.");

      clock.set('2099-01-01T00:00:00Z');
      const keptIo = new ScriptedIo();
      kept(context(), keptIo);
      expect(keptIo.text).toContain('Never returns (kept forever)');
    });

    it('unsuppress ends a hold early and keeps the history', async () => {
      const io = new ScriptedIo(['keep', 'quit']);
      await review(context(), {}, io);

      const senderId = reviewOrder(db, clock)[0]?.senderId ?? '';
      const unsuppressIo = new ScriptedIo();
      unsuppress(context(), senderId, unsuppressIo);
      expect(unsuppressIo.text).toContain('history stays readable');

      // The Keep is still in the log; the projection just no longer suppresses.
      const log = db
        .prepare<[string], { decision: string }>(
          'SELECT decision FROM decision WHERE sender_id = ? ORDER BY id',
        )
        .all(senderId)
        .map((r) => r.decision);
      expect(log).toEqual(['keep', 'unsuppress']);

      const after = new ScriptedIo();
      await review(context(), { noSync: true, listOnly: true }, after);
      expect(after.lines.filter((l) => /^\s+\d+\s{2,}/.test(l))).toHaveLength(5);
    });
  });

  describe('unsubscribing', () => {
    it('refuses to act on a suspicious sender by default', async () => {
      const io = new ScriptedIo();
      await review(context(), { listOnly: true }, io);

      const suspicious = aggregatedSenders(db).find((s) => s.suspicious);
      expect(suspicious).toBeDefined();

      // Answer "unsubscribe" for every sender.
      const decideAll = new ScriptedIo(Array(10).fill('unsubscribe'));
      await review(context(), { noSync: true }, decideAll);

      const attempt = db
        .prepare<[string], { result: string }>(
          'SELECT result FROM unsubscribe_attempt WHERE sender_id = ?',
        )
        .get(suspicious?.senderId ?? '');
      expect(attempt?.result).toBe('skipped_suspicious');

      // Skipped means undecided: it must stay on the list.
      const after = new ScriptedIo();
      await review(context(), { noSync: true, listOnly: true }, after);
      expect(after.text).toContain('Your Bank Rewards');
    });

    it('records an attempt and a decision for a sender it did act on', async () => {
      const io = new ScriptedIo(['unsubscribe', 'quit']);
      await review(context(), {}, io);

      expect(
        db
          .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM unsubscribe_attempt')
          .get()?.n,
      ).toBe(1);
      expect(
        db
          .prepare<[], { n: number }>(
            "SELECT COUNT(*) AS n FROM decision WHERE decision = 'unsubscribe'",
          )
          .get()?.n,
      ).toBe(1);
    });
  });

  describe('merge', () => {
    it('combines two senders and keeps the messages', async () => {
      const io = new ScriptedIo();
      await review(context(), { listOnly: true }, io);

      const senders = aggregatedSenders(db);
      const [a, b] = senders;
      const totalBefore = senders.reduce((n, s) => n + s.messageCount, 0);

      const mergeIo = new ScriptedIo();
      merge(context(), a?.senderId ?? '', b?.senderId ?? '', mergeIo);
      expect(mergeIo.text).toContain('replayed if the grouping rules ever change');

      const after = aggregatedSenders(db);
      expect(after).toHaveLength(senders.length - 1);
      expect(after.reduce((n, s) => n + s.messageCount, 0)).toBe(totalBefore);
    });
  });

  describe('status', () => {
    it('reports the sync watermark and the pending count', async () => {
      const io = new ScriptedIo();
      await review(context(), { listOnly: true }, io);

      const statusIo = new ScriptedIo();
      await status(context(), undefined, statusIo);

      expect(statusIo.text).toContain('INBOX: up to UID 6');
      expect(statusIo.text).toContain('UIDVALIDITY 7');
      expect(statusIo.text).toContain('awaiting a decision');
      expect(statusIo.text).toContain('No senders hidden');
    });

    it('explains one sender in full, including its decision log', async () => {
      const io = new ScriptedIo(['keep', 'quit']);
      await review(context(), {}, io);

      const senderId = reviewOrder(db, clock)[0]?.senderId ?? '';
      const statusIo = new ScriptedIo();
      await status(context(), senderId, statusIo);

      expect(statusIo.text).toContain('Identities');
      expect(statusIo.text).toContain('normalized_key:');
      expect(statusIo.text).toContain('Decisions (append-only)');
      expect(statusIo.text).toContain('keep → until');
    });
  });
});
