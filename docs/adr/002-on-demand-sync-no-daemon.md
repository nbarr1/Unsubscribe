# ADR-002: On-demand sync, no daemon, no scheduler

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

The tool is used about six times a year. A background daemon would keep the
local database warm so `review` renders instantly.

It would also be the single most likely thing to be broken on the sixth visit:
a launchd plist or systemd unit that fails after an OS upgrade, a credential
that expired months ago with the error going to a log nobody reads, a schema
migration that never ran because the service is pinned to an old binary. The
user finds out only when they finally sit down to review — precisely the moment
they wanted the tool to work.

A daemon also earns nothing here. Six sessions a year means at most six syncs.
Making each one two minutes slower is a rounding error; making one of them fail
silently is the whole product.

## Decision

**Sync is on demand. The tool ships no daemon, no scheduler, no service file
and no install hook.**

- `unsub review` syncs before rendering. The user never has to remember to sync.
- `unsub sync` exists as a separate command so the user can wire it to `cron` or
  a launch agent themselves if they ever want to. That is their configuration,
  living in their crontab, not ours.
- The first run backfills a bounded window, default 12 months, overridable with
  `--since`.

### Sync must be resumable and idempotent

With on-demand sync, interruption is the common case, not the rare one: the user
runs `review`, sees it will take a while, hits Ctrl-C, comes back after lunch.
Therefore:

- Progress is committed as it is made, per batch, not in one transaction at the
  end. A killed sync keeps what it already learned.
- Message ingest is keyed so re-ingesting the same message is a no-op. Running
  `sync` twice must produce no duplicate rows; killing `sync` mid-run and
  re-running must produce no duplicate rows. Both are tested.
- The watermark for a folder only advances past a UID once that UID's message is
  durably recorded, so a crash can only ever cause re-work, never a gap.

### Progress must be visible

Without a progress indicator the first `review` of a session looks hung, and a
tool that looks hung gets killed. Sync reports folder, messages processed and
total.

## Consequences

- Nothing about this tool runs when the user is not running it. Nothing can rot
  in the background, because nothing is in the background.
- The first `review` after a long gap is the slow one. That is the correct place
  to put the cost: the user is present, watching a progress bar they asked for.
- No uninstall story is needed beyond deleting two files (see ADR-004).
