import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  foreignKeysEnabled,
  journalMode,
  migrate,
  openDatabase,
  type Db,
} from '../../src/storage/db.js';

describe('storage', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'unsub-test-'));
    db = openDatabase({ path: join(dir, 'test.db') });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('pragmas (ADR-004)', () => {
    it('enables WAL mode', () => {
      expect(journalMode(db)).toBe('wal');
    });

    it('enables foreign key enforcement on the connection', () => {
      // SQLite defaults this OFF, per connection. The schema depends on it.
      expect(foreignKeysEnabled(db)).toBe(true);
    });

    it('enforces foreign keys, not just reports them enabled', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO decision (sender_id, decision, decided_at)
             VALUES ('no-such-sender', 'keep', '2026-08-17T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('re-enables foreign keys on every new connection, not just the first', () => {
      const path = join(dir, 'reopen.db');
      const first = openDatabase({ path });
      first.close();
      const second = openDatabase({ path });
      expect(foreignKeysEnabled(second)).toBe(true);
      second.close();
    });
  });

  describe('migrations', () => {
    it('records what it applied', () => {
      const names = db
        .prepare<[], { name: string }>('SELECT name FROM migrations ORDER BY name')
        .all()
        .map((r) => r.name);
      expect(names).toContain('001_initial.sql');
    });

    it('is idempotent — a second run applies nothing', () => {
      expect(migrate(db)).toEqual([]);
    });

    it('creates every table the domain layer depends on', () => {
      const tables = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
          )
          .all()
          .map((r) => r.name),
      );
      for (const t of [
        'sender',
        'sender_identity',
        'sender_merge',
        'message',
        'decision',
        'unsubscribe_attempt',
        'sync_state',
      ]) {
        expect(tables).toContain(t);
      }
    });

    it('upgrades a database that was left alone (ADR-002: no daemon ran)', () => {
      const path = join(dir, 'stale.db');
      // Simulate a database created before any migration existed.
      const stale = openDatabase({ path, migrate: false });
      stale.close();

      const reopened = openDatabase({ path });
      const applied = reopened
        .prepare<[], { name: string }>('SELECT name FROM migrations')
        .all();
      expect(applied.length).toBeGreaterThan(0);
      reopened.close();
    });
  });

  describe('schema invariants (ADR-005)', () => {
    it('makes sender.id the only foreign key target', () => {
      const tables = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'migrations'",
        )
        .all()
        .map((r) => r.name);

      const targets = new Set<string>();
      for (const table of tables) {
        const fks = db.pragma(`foreign_key_list(${table})`) as Array<{
          table: string;
          to: string | null;
        }>;
        for (const fk of fks) {
          targets.add(`${fk.table}.${fk.to ?? 'rowid'}`);
        }
      }
      // Nothing may point at a normalised key, a domain, or an address —
      // those are observations whose rules will change (ADR-005).
      expect([...targets]).toEqual(['sender.id']);
    });

    it('rejects a sender_identity row for a sender that does not exist', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO sender_identity (sender_id, kind, value, first_seen_at)
             VALUES ('ghost', 'from_address', 'a@b.com', '2026-08-17T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('rejects an unknown identity kind', () => {
      db.prepare(
        `INSERT INTO sender (id, first_seen_at, last_seen_at, created_at)
         VALUES ('s1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO sender_identity (sender_id, kind, value, first_seen_at)
             VALUES ('s1', 'astrology', 'x', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it('gives an identity value to exactly one sender', () => {
      for (const id of ['s1', 's2']) {
        db.prepare(
          `INSERT INTO sender (id, first_seen_at, last_seen_at, created_at)
           VALUES (?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                   '2026-01-01T00:00:00.000Z')`,
        ).run(id);
      }
      const insert = db.prepare(
        `INSERT INTO sender_identity (sender_id, kind, value, first_seen_at)
         VALUES (?, 'list_id', 'news.example.com', '2026-01-01T00:00:00.000Z')`,
      );
      insert.run('s1');
      expect(() => insert.run('s2')).toThrow(/UNIQUE constraint failed/);
    });
  });
});
