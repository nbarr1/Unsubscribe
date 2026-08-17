# ADR-005: Sender identity — surrogate key plus identity observations

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

This is the highest-risk component in the system.

Grouping messages into "senders" requires normalisation, and **normalisation
rules will change.** A new VERP pattern will turn up. A newsletter platform will
need a special case. The Public Suffix List will have an edge case we got wrong.
That is not a hypothetical; it is the expected lifecycle of this code.

If a normalised key is the primary key that decisions point at, then every rule
change orphans decision history. The user clicks Keep, we later tweak a regex,
and the sender silently resurfaces — or worse, its Keep now applies to a
different group of mail than the one they looked at. That is precisely the
confusion this product exists to prevent.

Two failure modes are _not_ symmetric:

- **Over-merging** folds two subscriptions into one row. Annoying. The user sees
  it, splits it, moves on.
- **Splitting** a sender the user already decided on silently discards that
  decision. The mail comes back, the user does not know why, and their trust in
  the Kept view is gone.

So the design must make merging cheap and reversible, and must make splitting
something that only ever happens by explicit user action, never as a side effect
of a rule change.

## Decision

### Three layers

1. **`sender`** — an opaque surrogate `id` (UUID). Decisions, suppressions and
   unsubscribe attempts foreign-key to this and to nothing else. **Nothing but
   `sender.id` is ever a foreign key target.** Display fields on `sender` are
   caches, refreshed on ingest, never identity.

2. **`sender_identity`** — many rows per sender, each a `(kind, value)`
   observation:
   - `list_id` — the RFC 2919 `List-ID`
   - `from_address` — the literal, unmodified `From` address
   - `normalized_key` — the output of the normalisation rules below
   - `dkim_domain` — a `d=` domain from a `DKIM-Signature`

   Resolution is a lookup in this table. **A new normalisation rule adds
   identities; it never invalidates a decision**, because decisions do not point
   at identities.

   **Only three of the four kinds resolve.** `list_id`, `from_address` and
   `normalized_key` each belong to exactly one sender and are what ingest
   matches on. `dkim_domain` is recorded as an observation but is **not** used
   to pick a sender, and is not unique.

   The reason is that a DKIM `d=` domain is very often the sending _platform_ —
   `sendgrid.net`, `mailchimpapp.net`, `amazonses.com` — shared by thousands of
   unrelated senders. Resolving on it would fold every customer of a platform
   into one sender, so a single Keep would silently hide hundreds of unrelated
   newsletters. This ADR tolerates over-merging as "annoying, the user splits
   it and moves on", but that is a different order of over-merge: it destroys
   the per-sender decision the product exists to make, and the only repair is a
   split — the operation this ADR says must never be needed to recover from
   something the system did on its own.

   The observation is still stored, because it is what the detection layer
   compares an unsubscribe target against when setting the `suspicious` flag.

3. **`sender_merge`** — explicit, user-authored merges, stored as their own
   rows and **replayed after every normalisation rule change**. A `merge`
   command whose result does not survive re-normalisation is a trap: the user
   would fix a duplicate, and a later rule change would silently undo their fix.

### Normalisation, used to compute `normalized_key` identities

In order:

1. The **`List-ID`** header, if present. This is the correct list identity per
   RFC 2919 and the only signal the sender explicitly provides for the purpose.
2. Otherwise the **`From` address** with subaddressing (`+tag`) stripped and
   VERP-style variable segments normalised (`bounce-12345-abc@` → `bounce-*@`).
   Newsletter platforms rotate the local part per recipient; naive grouping on
   the full address fragments one sender into hundreds of rows.
3. Otherwise the **registrable domain** of the `From` address, computed with the
   Public Suffix List — not a last-two-labels split, which gets `co.uk`,
   `github.io` and `s3.amazonaws.com` wrong.

### Resolution on ingest

Compute all candidate identities for the message. If any matches an existing
`sender_identity` row, that is the sender; record any new identities against it.
Otherwise create a new `sender`.

### Never auto-split

Nothing in the ingest path, and nothing in a rule change, may move messages away
from a sender that has a decision recorded against it.

Watch the domain fallback specifically: `notifications@github.com` and
`noreply@github.com` are genuinely different subscriptions to a user, and rule 3
would fold them together. Therefore rule 3 is a last resort, `List-ID` is
strongly preferred, and the interface offers a **split affordance before any
decision is recorded** so over-merges get fixed while they are still free.

`merge` and `split` are user commands, and both are persisted.

## Consequences

- Resolution is one indexed lookup per candidate identity. Cheap.
- Re-normalisation is a maintenance operation that adds `normalized_key` rows
  and replays `sender_merge`. It is safe to run at any time and is expected to
  be run after any change to the rules.
- The system can hold two identities that "should" be the same without harm; it
  simply has two senders until the user merges them.
- **Test obligation:** changing a normalisation rule and re-running must not
  orphan or resurface any existing decision. This is proved by a test, not by
  argument.
