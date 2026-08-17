# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added

- The six architecture decision records in `docs/adr/`, covering mail access
  (ADR-001), sync model (ADR-002), interface layer (ADR-003), storage
  (ADR-004), sender identity (ADR-005) and suppression semantics (ADR-006).
- Repository scaffold: TypeScript in strict mode, ESLint, Prettier, Vitest with
  an enforced 90% coverage floor on `src/domain` and `src/detection`, and a
  GitHub Actions workflow running lint, format, typecheck and test.
- **Storage.** SQLite via `better-sqlite3`, used synchronously, with WAL and
  `foreign_keys` enabled on every connection and verified by tests. Numbered SQL
  migrations applied automatically on open, so a database left untouched for
  months upgrades itself on next use.
- **Sender identity.** Resolution against an opaque surrogate id, with
  `List-ID`, literal address, and normalised-key identities. Normalisation
  strips subaddressing, collapses VERP segments, and falls back to the
  registrable domain via the Public Suffix List. A test proves that changing a
  normalisation rule cannot orphan or resurface an existing decision.
- **Suppression.** An append-only decision log projected at read time.
  Calendar-month arithmetic on the user's local calendar with day-of-month
  clamping, tested across Jan 31, leap years and both DST transitions.
  `--for <duration>` and `--forever` extend the default three-month hold.
- **Detection.** Four tiers — RFC 8058 one-click, RFC 2369 https link, mailto,
  and body-scraped links matched against a maintained multilingual token list.
  Bodies are fetched only for messages where all three header tiers failed. A
  `suspicious` flag marks unsubscribe targets whose registrable domain matches
  neither the `From` domain nor any DKIM `d=`.
- **Sync.** Resumable, idempotent, and `UIDVALIDITY`-aware, against a
  `MailProvider` interface with an in-memory fake for tests. Progress is
  committed per batch, so an interrupted sync resumes rather than restarting and
  cannot double-count.
- **Commands.** `auth`, `sync`, `review`, `kept`, `unsuppress`, `merge`,
  `split`, `status`.
- **Unsubscribe execution.** One-click POSTs with a timeout and a small redirect
  limit; links open in the browser and are marked `pending_manual` rather than
  being fetched; mailto sends through the authenticated account honouring
  `subject` and `body`; suspicious senders require `--confirm-suspicious`. Every
  attempt is recorded, and senders still mailing more than ten days later are
  flagged.
- **README** covering install, first run, every command, the three-month keep
  window, where data and credentials live, backup and deletion, privacy posture
  and known limitations.

### Notes

- `dkim_domain` is stored as an observation but does **not** resolve a sender to
  avoid folding every customer of a shared sending platform into one record. The
  reasoning is recorded in ADR-005.
