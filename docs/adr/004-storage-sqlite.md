# ADR-004: Storage — SQLite via `better-sqlite3`

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

The tool needs durable local state: messages seen, senders, identities,
decisions, unsubscribe attempts, sync watermarks. It is single-user,
single-process, and used a handful of times a year. The data must still be
readable — and explicable — in four months.

## Decision

**SQLite, one file, accessed with `better-sqlite3`.**

- **Synchronous API, used synchronously.** `better-sqlite3` is synchronous by
  design and is faster that way. Do not wrap it in promises. There is no server
  here and no concurrency to hide; async wrapping would only add failure modes
  and make transactions harder to reason about.
- **WAL mode on**, for crash resilience across interrupted syncs (ADR-002).
- **`PRAGMA foreign_keys = ON` on every connection.** SQLite defaults this to
  _off_, per connection, and the schema depends on it — a decision row pointing
  at a deleted sender is exactly the silent corruption this product cannot
  afford. This is verified by a test, not by hoping.
- **Migrations are checked into the repository** as numbered SQL files, applied
  in order, recorded in a `migrations` table, run automatically on open. A
  four-month-old database must upgrade itself when the user next runs the tool.
- **One file in a user config directory:** `~/.config/unsubscribe-manager/` on
  Linux, `~/Library/Application Support/unsubscribe-manager/` on macOS,
  `%APPDATA%\unsubscribe-manager\` on Windows. Overridable with
  `UNSUB_DATA_DIR` for tests and for users who keep dotfiles elsewhere.

## Consequences

- Backup is `cp unsubscribe.db*`. Deletion is `rm -rf` on one directory plus one
  keychain entry. Both are documented in the README.
- The database is inspectable with any `sqlite3` shell, which is the best
  possible answer to "why is this sender not showing up?" — the state is a
  table, not an object graph in a process that is no longer running.
- `better-sqlite3` is a native module and needs a prebuilt binary or a
  toolchain at install time. Accepted: it is the single most stable native
  module in this space, and the alternative (`node:sqlite`, WASM builds) either
  moved recently or adds an async layer we just rejected.
- WAL leaves `-wal` and `-shm` sidecar files next to the database. Backup
  instructions must copy them too, or checkpoint first.
