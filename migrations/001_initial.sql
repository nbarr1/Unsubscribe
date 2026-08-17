-- 001_initial.sql
--
-- The whole schema, as specified by ADR-004 (storage), ADR-005 (sender
-- identity) and ADR-006 (suppression semantics).
--
-- Two invariants run through everything below and are worth stating once:
--
--   1. `sender.id` is the ONLY foreign key target in this schema (ADR-005).
--      Decisions, unsubscribe attempts and messages all point at it. Nothing
--      points at a normalised key, a domain, or an address, because those are
--      observations whose rules will change.
--
--   2. Nothing is ever updated to express a decision (ADR-006). Decisions are
--      appended. Current state is a projection computed at read time, which is
--      what makes "why is this sender back?" answerable months later.

-- ---------------------------------------------------------------------------
-- sender: the opaque surrogate identity.
-- ---------------------------------------------------------------------------
CREATE TABLE sender (
  id               TEXT PRIMARY KEY,       -- UUID. Opaque. Never derived.
  -- Everything below is a display cache refreshed on ingest, never identity.
  display_name     TEXT,
  display_address  TEXT,
  first_seen_at    TEXT NOT NULL,          -- UTC ISO-8601
  last_seen_at     TEXT NOT NULL,          -- UTC ISO-8601
  created_at       TEXT NOT NULL,
  -- Set when this sender was folded into another by an explicit user merge.
  -- The row is kept so its history and any decisions remain readable.
  merged_into      TEXT REFERENCES sender (id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_sender_merged_into ON sender (merged_into);
CREATE INDEX idx_sender_last_seen ON sender (last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- sender_identity: many (kind, value) observations per sender (ADR-005 layer 2)
--
-- Resolution on ingest is a lookup here. A new normalisation rule ADDS rows to
-- this table; it never invalidates a decision, because decisions do not point
-- at identities.
--
-- Three of the four kinds RESOLVE: a (kind, value) pair for list_id,
-- from_address or normalized_key belongs to exactly one sender, enforced by the
-- partial unique index below.
--
-- `dkim_domain` is recorded but does NOT resolve, and is deliberately not
-- unique. A DKIM d= domain is frequently the sending *platform* —
-- sendgrid.net, mailchimpapp.net, amazonses.com — shared by thousands of
-- unrelated senders. A unique constraint would make the second SendGrid
-- customer fail to ingest, and resolving on it would fold every SendGrid
-- customer into one sender, so a single Keep would silently hide hundreds of
-- newsletters. It is kept because it is what the detection layer compares an
-- unsubscribe target against for the `suspicious` flag. See ADR-005.
-- ---------------------------------------------------------------------------
CREATE TABLE sender_identity (
  sender_id     TEXT NOT NULL REFERENCES sender (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (
                  kind IN ('list_id', 'from_address', 'normalized_key', 'dkim_domain')
                ),
  value         TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (sender_id, kind, value)
) STRICT;

CREATE UNIQUE INDEX idx_sender_identity_resolving
  ON sender_identity (kind, value)
  WHERE kind IN ('list_id', 'from_address', 'normalized_key');

CREATE INDEX idx_sender_identity_lookup ON sender_identity (kind, value);
CREATE INDEX idx_sender_identity_sender ON sender_identity (sender_id);

-- ---------------------------------------------------------------------------
-- sender_merge: explicit, user-authored merges (ADR-005 layer 3)
--
-- Persisted as their own rows so they can be REPLAYED after any normalisation
-- rule change. A merge that does not survive re-normalisation is a trap.
-- `split` appends a row with active = 0 rather than deleting, so the history of
-- what the user decided about grouping is itself append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE sender_merge (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT NOT NULL REFERENCES sender (id) ON DELETE CASCADE,
  target_id    TEXT NOT NULL REFERENCES sender (id) ON DELETE CASCADE,
  merged_at    TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note         TEXT,
  CHECK (source_id <> target_id)
) STRICT;

CREATE INDEX idx_sender_merge_source ON sender_merge (source_id);
CREATE INDEX idx_sender_merge_target ON sender_merge (target_id);

-- ---------------------------------------------------------------------------
-- message: one row per message carrying an unsubscribe signal.
--
-- The primary key is the RFC 5322 Message-ID where present, falling back to a
-- synthesised `folder:uidvalidity:uid` key. This is what makes sync idempotent
-- (ADR-002): re-ingesting the same message is an INSERT OR IGNORE that changes
-- nothing, so running sync twice, or killing it mid-run and re-running, cannot
-- double-count.
-- ---------------------------------------------------------------------------
CREATE TABLE message (
  id                TEXT PRIMARY KEY,      -- Message-ID, or folder:uidvalidity:uid
  sender_id         TEXT NOT NULL REFERENCES sender (id) ON DELETE CASCADE,
  folder            TEXT NOT NULL,
  uidvalidity       INTEGER NOT NULL,
  uid               INTEGER NOT NULL,
  received_at       TEXT NOT NULL,         -- UTC ISO-8601
  subject           TEXT,
  from_name         TEXT,
  from_address      TEXT NOT NULL,
  list_id           TEXT,
  -- Detection result for THIS message (see src/detection).
  method            TEXT NOT NULL CHECK (
                      method IN ('one_click', 'http_link', 'mailto', 'body_link')
                    ),
  confidence        REAL NOT NULL,
  unsubscribe_uri   TEXT,
  -- 1 when the unsubscribe target's registrable domain matches neither the
  -- From domain nor any DKIM d= domain. Correlates with phishing/list-washing.
  suspicious        INTEGER NOT NULL DEFAULT 0 CHECK (suspicious IN (0, 1)),
  ingested_at       TEXT NOT NULL
) STRICT;

CREATE INDEX idx_message_sender ON message (sender_id, received_at DESC);
CREATE INDEX idx_message_folder_uid ON message (folder, uidvalidity, uid);
CREATE INDEX idx_message_received ON message (received_at DESC);

-- ---------------------------------------------------------------------------
-- decision: the append-only log (ADR-006).
--
-- `suppressed_until` NULL on a 'keep' means never resurface. On 'unsubscribe'
-- and 'unsuppress' it is unused. Current state is the LATEST row per sender;
-- nothing here is ever updated or deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE decision (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id         TEXT NOT NULL REFERENCES sender (id) ON DELETE CASCADE,
  decision          TEXT NOT NULL CHECK (
                      decision IN ('keep', 'unsubscribe', 'unsuppress')
                    ),
  decided_at        TEXT NOT NULL,         -- UTC ISO-8601
  suppressed_until  TEXT,                  -- UTC ISO-8601; NULL = forever
  note              TEXT
) STRICT;

-- The review projection asks "latest decision per sender" on every render, so
-- this index is doing the actual work of the suppression query.
CREATE INDEX idx_decision_sender_time ON decision (sender_id, decided_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- unsubscribe_attempt: every attempt, whatever the outcome.
--
-- Kept forever. `still_sending` is derived by comparing message.received_at
-- against attempted_at + 10 days, which is meaningful under CAN-SPAM's
-- 10-business-day rule as well as being useful.
-- ---------------------------------------------------------------------------
CREATE TABLE unsubscribe_attempt (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id      TEXT NOT NULL REFERENCES sender (id) ON DELETE CASCADE,
  method         TEXT NOT NULL CHECK (
                   method IN ('one_click', 'http_link', 'mailto', 'body_link')
                 ),
  attempted_at   TEXT NOT NULL,
  result         TEXT NOT NULL CHECK (
                   result IN ('success', 'pending_manual', 'failed', 'skipped_suspicious')
                 ),
  http_status    INTEGER,
  target_uri     TEXT,
  sent_message_id TEXT,                    -- for mailto: the Message-ID we sent
  error          TEXT
) STRICT;

CREATE INDEX idx_attempt_sender ON unsubscribe_attempt (sender_id, attempted_at DESC);

-- ---------------------------------------------------------------------------
-- sync_state: the (UIDVALIDITY, UID) watermark per folder (ADR-001, ADR-002).
--
-- `uidvalidity` changing means every UID we stored for this folder is
-- meaningless, so the watermark is discarded and the folder resynced.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_state (
  folder         TEXT PRIMARY KEY,
  uidvalidity    INTEGER NOT NULL,
  last_uid       INTEGER NOT NULL,
  last_synced_at TEXT NOT NULL,
  -- The start of the backfill window this folder was synced from, so a later
  -- run with a wider --since knows it has to go back further.
  backfill_since TEXT
) STRICT;
