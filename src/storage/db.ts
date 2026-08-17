import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { databasePath } from './paths.js';

export type Db = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Find the checked-in migrations directory.
 *
 * `src/storage/` and `dist/storage/` are both one directory below a package
 * root that contains `migrations/`, so the same relative walk works whether we
 * are running from source via tsx or from a build.
 */
export function migrationsDir(): string {
  for (const candidate of [
    join(HERE, '..', '..', 'migrations'),
    join(HERE, '..', '..', '..', 'migrations'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate the migrations directory (looked relative to ${HERE}). ` +
      'The installation is incomplete.',
  );
}

/**
 * Apply the pragmas ADR-004 requires.
 *
 * `foreign_keys` is per-connection and OFF by default in SQLite. The schema
 * depends on it, so it is set here — on the single place a connection can be
 * opened — and asserted by a test rather than hoped for.
 */
function applyPragmas(db: Db): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Wait rather than fail if something else holds the write lock. There is only
  // ever one writer here, but a stray `sqlite3` shell shouldn't break a sync.
  db.pragma('busy_timeout = 5000');
}

export interface AppliedMigration {
  name: string;
  appliedAt: string;
}

/**
 * Apply every migration not yet recorded, in filename order, each in its own
 * transaction. Runs automatically on open: a database left alone for four
 * months has to be able to upgrade itself the next time the tool starts.
 */
export function migrate(db: Db, dir: string = migrationsDir()): AppliedMigration[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const already = new Set(
    db
      .prepare<[], { name: string }>('SELECT name FROM migrations')
      .all()
      .map((r) => r.name),
  );

  const pending = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !already.has(f));

  const applied: AppliedMigration[] = [];
  const record = db.prepare<[string, string]>(
    'INSERT INTO migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const name of pending) {
    const sql = readFileSync(join(dir, name), 'utf8');
    const appliedAt = new Date().toISOString();
    db.transaction(() => {
      db.exec(sql);
      record.run(name, appliedAt);
    })();
    applied.push({ name, appliedAt });
  }

  return applied;
}

export interface OpenOptions {
  /** Explicit database file path. Defaults to the ADR-004 location. */
  path?: string;
  /** Skip running migrations. Only useful for migration tests. */
  migrate?: boolean;
  readonly?: boolean;
}

/**
 * Open the database, creating the directory and applying migrations.
 *
 * `better-sqlite3` is synchronous by design (ADR-004) and is not wrapped.
 */
export function openDatabase(options: OpenOptions = {}): Db {
  const file = options.path ?? databasePath();
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = new Database(file, options.readonly === true ? { readonly: true } : {});
  applyPragmas(db);

  if (options.migrate !== false && options.readonly !== true) {
    migrate(db);
  }
  return db;
}

/** True when this connection has foreign key enforcement on. */
export function foreignKeysEnabled(db: Db): boolean {
  return db.pragma('foreign_keys', { simple: true }) === 1;
}

/** The journal mode of this database, lowercased ('wal' when ADR-004 holds). */
export function journalMode(db: Db): string {
  return String(db.pragma('journal_mode', { simple: true })).toLowerCase();
}
