# ADR-001: Mail access via IMAP with an app password

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

The tool must read one personal mailbox to find messages that carry unsubscribe
signals. It runs on the owner's machine, six times a year, with no server
component.

The realistic options are:

1. **IMAP with an app password.** Universal, boring, works against Gmail,
   Fastmail, Proton Bridge, self-hosted Dovecot, anything.
2. **Gmail REST API with OAuth.** Richer (labels, search operators, batching)
   but requires registering a Google Cloud project, maintaining an OAuth client,
   and refreshing tokens. Unverified apps have their refresh tokens expired
   after seven days of test-mode use, and consent screens change.
3. **Reading a local Maildir/mbox.** Requires a separate sync tool
   (`mbsync`/`offlineimap`) that itself needs maintenance.

Option 2 fails the abandonment test hardest: an OAuth client that works today is
exactly the kind of thing that silently stops working in four months, and the
failure surfaces as an opaque `invalid_grant` at the moment the user wants to
work. Option 3 adds a moving part outside this repository.

## Decision

**Read mail over IMAP, authenticated with an app password, using `imapflow`.**

Consequences that are part of this decision, not implementation detail:

- **Headers only, by default.** Fetch via
  `BODY.PEEK[HEADER.FIELDS (...)]` so the server never sets `\Seen`. This tool
  must be invisible to the mailbox.
- **Full body only on fallthrough.** Fetch a full body only when header-based
  detection (tiers 1–3) yields nothing and body scraping (tier 4) is the last
  resort. Also via `BODY.PEEK[]`.
- **Sync position is `(UIDVALIDITY, UID)` per folder.** A bare UID is
  meaningless across a `UIDVALIDITY` change. If `UIDVALIDITY` changes, the
  stored watermark for that folder is discarded and the folder is resynced from
  the configured window.
- **Everything behind a `MailProvider` interface.** The sync engine, detection
  and domain layers never import `imapflow`. A `GmailProvider` on the Gmail REST
  API is a later, optional addition, built only if Gmail label support is
  actually requested.
- **The credential lives in the OS keychain** via `keytar`, falling back to a
  `0600` file in the config directory when no keychain is available (headless
  Linux). Never in the repository. Never in a `.env` file that gets committed.

### Precondition

App passwords require that the account still issues them. Google restricts them
to accounts with 2-Step Verification enabled and disables them entirely for
accounts under Advanced Protection or some Workspace policies. **Confirm the
target account can still issue an app password before writing IMAP code.** If it
cannot, this ADR is void and the choice moves to option 2.

## Consequences

- Works against any mailbox with IMAP, not just Gmail.
- No OAuth client to register, no token refresh to rot.
- No server-side search: the sync engine walks UIDs and decides locally. For one
  mailbox and a 12-month window this is fine, and it keeps the provider
  interface small enough that a fake implementation is trivial to write.
- Gmail-specific concepts (labels, `All Mail` deduplication) are unavailable.
  Gmail exposes labels as IMAP folders, which is a good enough approximation.
- An app password grants full mailbox access, including write and delete. The
  tool must never use it for either; see ADR-002 and the read-only guarantee in
  the README.
