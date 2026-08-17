# Architecture Decision Records

These ADRs are binding. Code that contradicts an accepted ADR is a bug in the
code, not a permitted variation. If an ADR turns out to be wrong, amend the ADR
first (in its own commit, with a `Superseded by` link), then change the code.

| ADR                                         | Title                                                  | Status   |
| ------------------------------------------- | ------------------------------------------------------ | -------- |
| [001](001-mail-access-imap-app-password.md) | Mail access via IMAP with an app password              | Accepted |
| [002](002-on-demand-sync-no-daemon.md)      | On-demand sync, no daemon, no scheduler                | Accepted |
| [003](003-interface-layer.md)               | Interface layer: CLI + TUI vs. local web app           | Accepted |
| [004](004-storage-sqlite.md)                | Storage: SQLite via `better-sqlite3`                   | Accepted |
| [005](005-sender-identity.md)               | Sender identity: surrogate key + identity observations | Accepted |
| [006](006-suppression-semantics.md)         | Suppression as an append-only decision log             | Accepted |

## Context that shapes every decision here

Single user. One mailbox. Runs on one laptop. No hosting, no ops, no uptime
requirement. Used roughly six times a year, and each use makes irreversible
decisions on the user's behalf.

**The dominant failure mode is abandonment, not overload.** Optimise for "still
works when I come back in four months." Prefer fewer moving parts over better
performance, every time. A feature that adds something which can silently break
between sessions is a net negative even when it is faster.
