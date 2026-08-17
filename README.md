# Unsubscribe Manager

A personal tool that reads your inbox, works out which senders offer an
unsubscribe mechanism, aggregates them by sender, and lets you periodically
review the list and decide — per sender — whether to keep receiving mail or to
unsubscribe.

Keeping a sender hides it from your review list for at least 3 months, and the
tool always tells you how many senders are hidden and when each returns.

> **Status:** under construction. The design is settled and recorded in
> [`docs/adr/`](docs/adr/); those ADRs are binding. Full usage documentation
> lands with the interface layer.

## Design

Start with [`docs/adr/README.md`](docs/adr/README.md). The short version:

- **It runs on your machine, on demand, and stores everything locally.** No
  server, no daemon, no telemetry.
- **It only ever reads your mail.** Messages are fetched with `BODY.PEEK` so
  they are never marked read, and nothing is deleted or modified.
- **It is optimised against abandonment**, not throughput. The failure mode
  that matters is coming back in four months and finding it broken.

## License

MIT. See [LICENSE](LICENSE).
