import type { Headers } from '../detection/mime.js';

/**
 * The mail source, behind an interface (ADR-001).
 *
 * The sync engine, detection and domain layers never import `imapflow`. That is
 * what makes the fake provider in `fake.ts` a complete substitute, and it is
 * what would let a `GmailProvider` be added later without touching anything
 * else.
 */

/** A folder's current state, as the server reports it. */
export interface FolderStatus {
  folder: string;
  /**
   * The folder's `UIDVALIDITY`. When this changes, every UID previously
   * recorded for the folder is meaningless and the watermark is discarded.
   */
  uidValidity: number;
  /** The UID the next arriving message will get. */
  uidNext: number;
  messageCount: number;
}

/** A message as fetched with headers only — the default (ADR-001). */
export interface FetchedHeaders {
  folder: string;
  uid: number;
  uidValidity: number;
  /** The server's internal date, as a UTC instant. */
  internalDate: Date;
  headers: Headers;
}

export interface FetchRange {
  /** Fetch UIDs strictly greater than this. */
  afterUid?: number | undefined;
  /** Ignore messages older than this. Bounds the first-run backfill. */
  since?: Date | undefined;
}

/**
 * The header fields worth fetching.
 *
 * Kept minimal and explicit: this list is what goes into
 * `BODY.PEEK[HEADER.FIELDS (...)]`, so anything absent here is not merely
 * unused — it is never transferred.
 */
export const HEADER_FIELDS: readonly string[] = [
  'From',
  'To',
  'Subject',
  'Date',
  'Message-ID',
  'List-ID',
  'List-Unsubscribe',
  'List-Unsubscribe-Post',
  'DKIM-Signature',
];

export interface SentMessage {
  messageId: string;
}

export interface MailProvider {
  /** Human-readable source description, for `unsub status`. */
  readonly description: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  listFolders(): Promise<string[]>;
  status(folder: string): Promise<FolderStatus>;

  /**
   * Stream headers for a folder in ascending UID order.
   *
   * Ascending order is not cosmetic: it is what lets the sync engine advance a
   * `(UIDVALIDITY, UID)` watermark as it goes, so an interrupted run resumes
   * from where it stopped instead of starting over (ADR-002).
   *
   * Implementations must never mark messages read — `BODY.PEEK`, always.
   */
  fetchHeaders(folder: string, range: FetchRange): AsyncIterable<FetchedHeaders>;

  /**
   * Fetch one full message body.
   *
   * Called only when header-based detection was inconclusive for that specific
   * message. Also `BODY.PEEK`.
   */
  fetchBody(folder: string, uid: number): Promise<string>;

  /**
   * Send a message through the authenticated account, for `mailto:`
   * unsubscribes. Optional: a provider that cannot send simply omits it, and
   * the unsubscribe executor reports mailto as unavailable rather than failing
   * at the last step.
   */
  send?(message: { to: string; subject: string; body: string }): Promise<SentMessage>;
}
