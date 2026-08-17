# Unsubscribe Manager

A personal tool that reads your inbox, works out which senders offer an
unsubscribe mechanism, aggregates them by sender, and lets you periodically sit
down and decide — per sender — whether to keep receiving mail or to unsubscribe.

The point is not to unsubscribe from everything. The point is to make the
decision **once**, deliberately, and then not be asked again for a while. So
keeping a sender hides it from your review list for at least three months, and
the tool is relentless about telling you what it is hiding and when each hidden
sender comes back.

Everything runs on your machine, on demand. No server, no daemon, no telemetry.
**It only ever reads your mail** — messages are fetched with `BODY.PEEK` so they
are never marked read, and nothing is ever moved, modified or deleted.

## What the review screen looks like

```
$ unsub review
  Syncing new mail…
  INBOX: 38 scanned, 38 with an unsubscribe signal.

  #   Sender                      Address                           Msgs  Last seen    Method
  ───────────────────────────────────────────────────────────────────────────────────────────
  1   Patagonia                   news@patagonia.example            14    Aug 18, 2026 one-click
  2   Weekly Roundup              bounce-88213-9f2c1a4b@bounce.mai… 9     Aug 21, 2026 link
  3   Example Shop                newsletter@example-shop.test      6     Aug 11, 2026 link
  4   discuss-request@lists.exam… discuss-request@lists.example.org 4     Aug 12, 2026 mailto
  5   The Dispatch                no-reply-8821@sendmail.newsplatf… 3     Aug 15, 2026 one-click
  6   Your Bank Rewards           rewards@bigbank.example           2     Aug 16, 2026 link ⚠

  12 senders hidden — kept within the last 3 months. Run 'unsub kept' to see them and their return dates.
  ⚠ marks a sender whose unsubscribe link points at an unrelated domain. These are never actioned without --confirm-suspicious.

? Patagonia — 14 messages, last Aug 18, 2026, one-click (Use arrow keys)
❯ Keep receiving (hidden for 3 months)
  Unsubscribe
  Skip for now
  Split this sender apart first
  Stop reviewing

  Keeping Patagonia. Won't ask again until Nov 22, 2026.
```

Senders are sorted by volume, because the one that sent you fourteen messages is
the one worth a decision.

## Prerequisites

- **Node 20 or newer.**
- **A mailbox that speaks IMAP.** Gmail, Fastmail, iCloud, Proton Bridge,
  self-hosted Dovecot — all fine.
- **An app password** for that mailbox (see below).

`better-sqlite3` and `keytar` are native modules. They ship prebuilt binaries
for common platforms; if yours is unusual, `npm install` will build them, which
needs a C++ toolchain (`build-essential` on Debian/Ubuntu, Xcode command line
tools on macOS). `keytar` is optional — if it will not install, the tool falls
back to a `0600` credential file and tells you it did.

## Generating an app password, and what it grants

An app password is a 16-character password that stands in for your real one for
a single application. It exists so you never type your actual password into a
third-party tool, and so you can revoke this tool's access without changing
anything else.

**For Google accounts:**

1. Turn on 2-Step Verification at
   [myaccount.google.com/security](https://myaccount.google.com/security). App
   passwords are only offered to accounts that have it.
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Name it something you will recognise in six months — `unsub` — and create it.
4. Copy the 16 characters. Google shows them once.

If that page will not load, your account is probably under Advanced Protection
or a Workspace policy that disables app passwords. This tool cannot work with
such an account today; see `docs/adr/001-mail-access-imap-app-password.md`.

**What it grants, honestly:** an app password gives full IMAP access to the
mailbox — read, write, flag and delete. There is no read-only variety. This tool
only ever reads (see the guarantee below), but the credential itself is not
limited, so treat it like a password. Revoke it from the same page the moment
you stop using this tool.

**Other providers:** Fastmail issues app passwords under Settings → Privacy &
Security → Integrations, and lets you scope them to IMAP only. iCloud calls them
app-specific passwords. Proton needs Proton Mail Bridge, which gives you local
IMAP credentials.

## Install and first run

```bash
git clone <this repo> unsubscribe-manager
cd unsubscribe-manager
npm install
npm run build
npm link          # puts `unsub` on your PATH
```

Prefer not to link? Every command below works as `npm run unsub -- <command>`.

Then:

```bash
unsub auth
```

It asks for your email address, the IMAP host (guessed from your address), and
the app password. The password prompt is hidden, and it is never accepted as a
command-line argument — that would put it in your shell history and in the
process list. `auth` signs in immediately, so a wrong password is reported now
rather than four months from now.

```bash
unsub review
```

The first run backfills twelve months. Depending on your mailbox that can take a
few minutes, and there is a progress bar so it does not look hung. **You can
safely kill it** — progress is committed as it goes, and re-running picks up
where it stopped. Running it twice cannot double-count anything.

## Commands

### `unsub auth`

Store the mailbox credential.

```bash
unsub auth
unsub auth --user you@gmail.com --host imap.gmail.com
unsub auth --folders "INBOX,[Gmail]/All Mail"   # Gmail exposes labels as folders
unsub auth --skip-verify                        # store without signing in first
```

Scanning `[Gmail]/All Mail` as well as `INBOX` catches newsletters you archived
without reading, which are usually exactly the ones worth unsubscribing from.

### `unsub review`

Sync, then decide per sender. This is the command you actually use.

```bash
unsub review
unsub review --list                  # print the list, ask nothing
unsub review --limit 20              # the twenty biggest senders
unsub review --no-sync               # review what is already stored
unsub review --include-suppressed    # show senders you kept, too
unsub review --since 24m             # widen the backfill window
unsub review --for 6m                # Keep means six months this session
unsub review --forever               # Keep means never ask again
unsub review --confirm-suspicious    # allow acting on ⚠ senders
```

Before the list, `review` reports any follow-ups: unsubscribe pages you opened
in a browser and never confirmed, and senders still mailing you more than ten
days after you unsubscribed.

### `unsub sync`

Fetch new mail without reviewing. `review` does this for you; this exists so you
can wire it to `cron` yourself if you ever want to. **The tool ships no
scheduler, service file or install hook** — see `docs/adr/002`.

```bash
unsub sync
unsub sync --since 2025-01-31
unsub sync --since 400d
unsub sync --folders "INBOX,Archive"
unsub sync --no-scrape-bodies   # headers only; skips tier-4 detection
unsub sync --quiet
```

### `unsub kept`

Everything currently hidden from review, soonest to return first.

```
$ unsub kept
  Patagonia
    news@patagonia.example
    Returns in 47 days (Nov 22, 2026) — kept on Aug 22, 2026
    14 messages in the window

  1 sender hidden from review.
```

### `unsub unsuppress <sender>`

End a hold early, so the sender is back on your next review list.

```bash
unsub unsuppress patagonia
unsub unsuppress news@patagonia.example
unsub unsuppress 0c4b9340          # an id prefix works too
```

The original Keep stays in the log. Nothing is deleted, ever, so "why is this
back?" always has an answer.

### `unsub merge <source> <target>` and `unsub split <sender>`

Sometimes one sender shows up as two rows — a newsletter that changed its
sending address, say. `merge` folds them together. `split` undoes a merge you
made earlier.

```bash
unsub merge news-old@shop.example news@shop.example
unsub split news-old@shop.example
```

Merges are recorded and re-applied if the grouping rules ever change, so a fix
you make today cannot be silently undone by a future update. The tool will
**never** split a sender apart on its own — that would discard a decision you
already made.

### `unsub status [sender]`

Where things stand overall, or everything known about one sender.

```
$ unsub status patagonia
  Patagonia
  id           0c4b9340-9d1c-4a5e-9a2f-1f0e7a4b8c31
  address      news@patagonia.example
  messages     14
  seen         May 2, 2026 → Aug 18, 2026
  method       one-click
  target       https://patagonia.example/u/one-click?t=9f2c1a
  state        kept on Aug 22, 2026; returns in 47 days (nov 22, 2026)

  Identities
    dkim_domain: patagonia.example
    from_address: news@patagonia.example
    list_id: stories.patagonia.example
    normalized_key: list:stories.patagonia.example

  Decisions (append-only)
    Aug 22, 2026  keep → until Nov 22, 2026
```

## The three-month keep window

This is the part worth reading carefully, because it is the promise the tool
exists to make.

**Keeping a sender hides it for three real calendar months** — Jan 31 plus three
months is Apr 30, not "90 days later". The date is computed in your local
timezone, so a hold that says it expires on Nov 17 expires on _your_ Nov 17.

**Three months is a floor, not a ceiling:**

| You want                 | Command                  |
| ------------------------ | ------------------------ |
| The default three months | just pick Keep           |
| Six months               | `unsub review --for 6m`  |
| A year                   | `unsub review --for 1y`  |
| Forty-five days          | `unsub review --for 45d` |
| Never ask again          | `unsub review --forever` |

**You are never left guessing what is hidden.**

- The review screen always ends with a footer, even when the count is zero:
  `12 senders hidden — kept within the last 3 months. Run 'unsub kept' to see
them and their return dates.`
- `unsub kept` shows each hidden sender with `Returns in 47 days (Nov 22, 2026)`
  and the date you made the decision.
- When a hold expires, the sender comes back tagged:
  `Returning — you kept this on May 12, 2026; the 3-month hold has expired.`
- Keeping something confirms with a real date:
  `Keeping Patagonia. Won't ask again until Nov 22, 2026.`

**Seeing or overriding a hold:**

```bash
unsub kept                          # what is hidden, and when each returns
unsub review --include-suppressed   # review everything, holds and all
unsub unsuppress patagonia          # end one hold now
unsub status patagonia              # the full decision history for one sender
```

Nothing expires "in the background", because nothing runs in the background. A
hold ends because the calendar moved past it, computed the moment you look.

## How senders are detected

Four tiers, most trustworthy first:

1. **One-click (RFC 8058)** — the sender published a `List-Unsubscribe-Post`
   header saying a single POST will unsubscribe you. This is the only method
   safe to perform automatically, and the only one the tool performs for you.
2. **Link (RFC 2369)** — an `https` URL in `List-Unsubscribe`. Opened in your
   browser; never fetched silently.
3. **Mailto** — an email address in `List-Unsubscribe`. The tool composes and
   sends the message through your account, honouring any subject and body the
   sender asked for.
4. **Body link** — no usable headers, so the message body is scanned for links
   whose text, `title`, `aria-label` or URL says unsubscribe, in any of a dozen
   languages. Always a guess; treated as one.

Tiers 1–3 read headers only. A full message body is downloaded **only** for a
message where all three failed.

**Why links are not clicked for you.** Plenty of unsubscribe links act on a bare
GET, or lead to a preference centre that needs a choice, or are tracking pixels
whose only real function is to confirm to a spammer that your address is live.
Fetching one silently can do nothing, do the wrong thing, or do harm — so you
look at it.

**The ⚠ flag** appears when the unsubscribe link points at a domain unrelated to
both the sender's address and its DKIM signature. It is not proof of anything,
but it correlates with phishing and list-washing, so nothing happens to those
senders without `--confirm-suspicious`.

## Where your data lives, and how to remove it

| What                                           | Where                                                         |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Database                                       | `~/.config/unsubscribe-manager/unsubscribe.db`                |
| Settings (host, address, folders — no secrets) | `~/.config/unsubscribe-manager/config.json`                   |
| Password                                       | your OS keychain, under the service `unsubscribe-manager`     |
| Password, if you have no keychain              | `~/.config/unsubscribe-manager/credentials.json`, mode `0600` |

On macOS that directory is `~/Library/Application Support/unsubscribe-manager/`;
on Windows it is `%APPDATA%\unsubscribe-manager\`. Set `UNSUB_DATA_DIR` to put
it somewhere else.

**Back it up.** The database is SQLite in WAL mode, so copy the sidecar files
too:

```bash
cp ~/.config/unsubscribe-manager/unsubscribe.db* /your/backup/
```

**Delete everything:**

```bash
rm -rf ~/.config/unsubscribe-manager
```

Then revoke the app password with your mail provider, and — on macOS — delete
the `unsubscribe-manager` entry from Keychain Access if you want to be thorough.

**Read it yourself.** It is a plain SQLite file, and that is deliberate: the
best possible answer to "why is this sender not showing up?" is a table you can
query without this program running.

```bash
sqlite3 ~/.config/unsubscribe-manager/unsubscribe.db \
  "SELECT decision, decided_at, suppressed_until FROM decision ORDER BY id"
```

## Privacy

- **All data is local.** One SQLite file on your machine.
- **No telemetry.** No analytics, no crash reporting, no update check, no phone
  home of any kind.
- **No third-party servers.** The only hosts contacted are your mail provider,
  and — when you unsubscribe — the sender's own unsubscribe endpoint.
- **Your mail is only ever read.** `BODY.PEEK` everywhere, so nothing is marked
  read, and there is no code path that writes a flag, moves a message or deletes
  one. Deletion is out of scope.
- **The credential goes to the OS keychain**, never into this repository and
  never into a `.env` file.

## Known limitations

- **Gmail labels** are visible only as IMAP folders. There is no Gmail API
  integration, on purpose (`docs/adr/001`).
- **No OAuth.** App password or nothing, for now.
- **Body scraping is a guess.** Tier 4 finds a link that looks like an
  unsubscribe. Sometimes that is a preference centre, and occasionally it is
  nothing useful at all.
- **Senders on a shared platform stay separate.** Two newsletters both sent
  through SendGrid are two senders, even where a human would say they are the
  same organisation. Grouping them on the platform's domain would let one Keep
  hide hundreds of unrelated newsletters, so `merge` is a manual command.
- **`--since` only widens.** Narrowing the window does not forget mail you have
  already recorded.
- **Unsubscribing is not always honoured.** The tool tracks whether mail keeps
  arriving and flags senders still mailing you after ten days, but it cannot
  make anyone stop.
- **One mailbox.** Multiple accounts would each need their own data directory
  via `UNSUB_DATA_DIR`.
- **No message preview.** The review list shows counts and dates, not contents.

## Design

The reasoning behind every significant decision is in
[`docs/adr/`](docs/adr/README.md), and those ADRs are binding on the code. Start
with [`docs/adr/README.md`](docs/adr/README.md).

The one that explains the rest: **the dominant failure mode for a tool used six
times a year is abandonment, not overload.** Everything here is optimised for
still working when you come back in four months, which is why there is no
daemon, no scheduler, no OAuth client, no server, and no background anything.

## Development

```bash
npm test              # 298 tests
npm run test:coverage # enforces 90% on src/domain and src/detection
npm run typecheck
npm run lint
```

Tests run against a fake mail provider and recorded `.eml` fixtures, so the
whole suite works with no network and no mailbox.

## License

MIT. See [LICENSE](LICENSE).
