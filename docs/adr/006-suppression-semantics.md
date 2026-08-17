# ADR-006: Suppression as an append-only decision log

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

"Keep this sender, and don't ask me again for three months" is the core promise
of the product. It is also the requirement most likely to be built sloppily: a
`suppressed_until` column on `sender`, updated in place, `+ 90 days`, computed
in whatever timezone the process happened to be in.

Every one of those shortcuts produces the same symptom four months later — a
sender is missing, or back, and the user cannot find out why. At that point the
tool has failed at its only job, because its only job is to be trustworthy about
what it is hiding.

## Decision

**Decisions are an append-only event log. Current state is a projection.**

- A Keep writes a `decision` row: `sender_id`, `decision='keep'`, `decided_at`,
  `suppressed_until`, optional `note`. Nothing is updated; nothing is deleted.
- **`suppressed_until` is derived from the latest `decision` row for a sender.**
  It is never a mutable column on `sender`. This is what makes the legibility
  requirements implementable as queries rather than as strings we hoped to store
  at write time, and it makes `unsuppress` an appended event rather than a
  destructive edit — so "why is this back?" always has an answer in the log.
- **True calendar-month arithmetic.** Add 3 months, clamping day-of-month
  (Jan 31 + 3 months = Apr 30). Not `+ 90 days`, which drifts and lands a
  sender back a day early or late depending on which months it crossed.
- **Store UTC ISO-8601. Compute and display in the user's local timezone.** A
  hold that expires "on Nov 17" must expire on the user's Nov 17.
- **The review query excludes senders whose latest decision has a future
  `suppressed_until`.** Rows are never deleted; expiry is computed at read time.
  A hold does not "run out" as a write — it runs out because the clock moved.
- **Three months is a floor, not a ceiling.** `suppressed_until = NULL` means
  never resurface. `--for 6m` and `--forever` are supported. The default stays
  3 months.
- **`unsuppress <sender>`** ends a hold early by appending an `unsuppress`
  decision. **`review --include-suppressed`** shows everything.

### The clock is injected everywhere

No domain function calls `Date.now()`. A `Clock` is a parameter. Every
suppression test must be able to fast-forward, and the suite must cover:

- **Jan 31 + 3 months** → Apr 30 (day-of-month clamping)
- **Nov 30 + 3 months** across a **leap year** boundary → Feb 29 vs Feb 28
- **DST transitions** — a hold set the day before a spring-forward must not
  expire an hour, or a day, early in local time

These are exactly where an off-by-one quietly resurfaces a sender, and a quiet
resurfacing is indistinguishable, to the user, from the tool being broken.

## Legibility requirements (non-negotiable)

The user must never wonder why a sender is or is not on the list. These are
product requirements, not interface polish, and they are all queries over the
decision log:

- Review screen footer, **always present**:
  `N senders hidden — kept within the last 3 months. Run 'unsub kept' to see them and their return dates.`
- `kept` view: each sender with `Returns in 47 days (Oct 3, 2026)` and the date
  the decision was made.
- A sender reappearing after expiry is tagged:
  `Returning — you kept this on May 12, 2026; the 3-month hold has expired.`
- Keep confirmations state a concrete date:
  `Keeping Patagonia. Won't ask again until Nov 17, 2026.`

## Consequences

- The full history of every decision is retained forever. At six sessions a year
  this is kilobytes.
- "Why is this sender back?" is answerable by reading rows, in a shell, months
  later, without the application running.
- Changing the default hold length changes future decisions only. Past holds are
  facts and keep the length they were given.
- Queries do slightly more work (latest-decision-per-sender). Irrelevant at this
  scale; the correct trade every time.
