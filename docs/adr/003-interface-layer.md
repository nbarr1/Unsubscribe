# ADR-003: Interface layer — CLI + TUI vs. local web app

- **Status:** **Open.** Must be confirmed before the interface layer is built.
- **Date:** 2026-08-17

## Context

Everything below the interface — storage, domain, detection, providers, sync —
is identical under either option. This ADR is deliberately deferred so that the
decision is made once, late, with the rest of the system already working.

The review flow is the only genuinely interactive surface: a list of senders,
each needing a per-sender Keep / Unsubscribe / Split decision, with legibility
requirements (return dates, suppression counts, suspicious flags) that must be
visible at the moment of choosing.

### Option A — CLI with an interactive TUI review flow (proposed default)

`commander` for command dispatch, `@inquirer/prompts` or `ink` for the review
flow.

- Fewest moving parts. No HTTP server, no port, no browser, no build step for a
  front end, no second language runtime in the loop.
- Survives abandonment best: a CLI that ran in 2026 runs in 2027.
- Trivially scriptable and pipeable; `--json` output is natural.
- Weaker at showing a lot of senders at once. Long lists are paged rather than
  scanned. No sender logos, no rich preview of the offending message.

### Option B — Local web app

Fastify serving a static SPA, bound to `127.0.0.1` only.

- Much better at "show me 200 senders sorted by volume and let me triage fast."
  Sorting, filtering and bulk selection are natural.
- Can render a message preview, which matters for deciding on a borderline
  sender.
- Costs: an HTTP server, a front-end build, a second dependency tree that ages
  faster than the back end, a browser in the loop, and a bind address that must
  never accidentally become `0.0.0.0`. Every one of those is a thing that can be
  broken in four months.

## Decision

Deferred. Default recommendation is **Option A**, on the abandonment argument in
`docs/adr/README.md`: a triage list of a few hundred rows is well within what a
paged terminal list handles, and the legibility requirements are all text.

The interface layer is not started until this ADR is confirmed and its status
changed to Accepted.

## Consequences (either way)

- The command surface is the same: `auth`, `sync`, `review`, `kept`,
  `unsuppress`, `merge`, `split`, `status`. Under Option B, `review` opens a
  browser instead of a prompt loop.
- All interface code lives in `src/cli/` (Option A) or `src/web/` (Option B) and
  depends on the domain layer through function calls only. No SQL, no
  `imapflow`, no date arithmetic in the interface layer.
- Legibility requirements (hidden-sender footer, return dates, `Returning` tags,
  concrete dates in confirmations) are requirements of the product, not of the
  chosen interface, and are queries in the domain layer either way.
