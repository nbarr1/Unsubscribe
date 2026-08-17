import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

import { parseHeaders } from '../detection/mime.js';
import {
  HEADER_FIELDS,
  type FetchRange,
  type FetchedHeaders,
  type FolderStatus,
  type MailProvider,
  type SentMessage,
} from './types.js';

/**
 * The real mail source (ADR-001).
 *
 * Two promises this class exists to keep:
 *
 *   **It never marks mail read.** Every fetch uses `BODY.PEEK`, both for
 *   headers and for the rare full body. `imapflow` peeks by default, and the
 *   fetch options below say so explicitly rather than relying on that.
 *
 *   **It never writes.** No flags, no moves, no deletes. This app reads.
 *   Deletion is out of scope, and there is no code path here that could perform
 *   one even by accident.
 */

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Implicit TLS. Effectively always true for port 993. */
  secure?: boolean;
}

export class ImapProvider implements MailProvider {
  readonly description: string;

  private client: ImapFlow | undefined;

  constructor(private readonly config: ImapConfig) {
    this.description = `imap://${config.user}@${config.host}:${config.port}`;
  }

  async connect(): Promise<void> {
    if (this.client !== undefined) return;
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure ?? this.config.port === 993,
      auth: { user: this.config.user, pass: this.config.password },
      // The library's own chatter is not useful to a person triaging
      // newsletters, and a log line containing an auth exchange is the last
      // thing this tool should print.
      logger: false,
    });
    await client.connect();
    this.client = client;
  }

  async disconnect(): Promise<void> {
    if (this.client === undefined) return;
    try {
      await this.client.logout();
    } finally {
      this.client = undefined;
    }
  }

  async listFolders(): Promise<string[]> {
    const client = this.require();
    const list = await client.list();
    return list
      .filter((entry) => !entry.flags.has('\\Noselect'))
      .map((entry) => entry.path);
  }

  async status(folder: string): Promise<FolderStatus> {
    const client = this.require();
    const status = await client.status(folder, {
      messages: true,
      uidNext: true,
      uidValidity: true,
    });
    return {
      folder,
      // imapflow reports UIDVALIDITY as a BigInt.
      uidValidity: Number(status.uidValidity ?? 0),
      uidNext: status.uidNext ?? 1,
      messageCount: status.messages ?? 0,
    };
  }

  /**
   * Stream headers in ascending UID order, headers only.
   *
   * `headers: HEADER_FIELDS` becomes `BODY.PEEK[HEADER.FIELDS (...)]` on the
   * wire, so nothing outside that list is transferred and nothing is marked
   * read. Ascending UID order is what lets the sync engine advance its
   * watermark as it goes (ADR-002).
   */
  async *fetchHeaders(folder: string, range: FetchRange): AsyncIterable<FetchedHeaders> {
    const client = this.require();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      const uidValidity =
        typeof mailbox === 'object' ? Number(mailbox.uidValidity ?? 0) : 0;

      const from = (range.afterUid ?? 0) + 1;
      const query: Record<string, unknown> = { uid: `${from}:*` };
      if (range.since !== undefined) query['since'] = range.since;

      for await (const message of client.fetch(query, {
        uid: true,
        internalDate: true,
        headers: HEADER_FIELDS as string[],
      })) {
        // A `uid:from:*` range always returns at least one message even when
        // nothing is above `from`, so filter rather than trusting the server.
        if (message.uid < from) continue;

        // A server that omits INTERNALDATE or the header block has given us
        // nothing to work with. Skipping is right: the watermark still
        // advances, so this does not wedge the sync on one bad message.
        const internalDate =
          message.internalDate instanceof Date
            ? message.internalDate
            : typeof message.internalDate === 'string'
              ? new Date(message.internalDate)
              : undefined;
        if (internalDate === undefined || Number.isNaN(internalDate.getTime())) continue;
        if (message.headers === undefined) continue;
        if (range.since !== undefined && internalDate < range.since) continue;

        yield {
          folder,
          uid: message.uid,
          uidValidity,
          internalDate,
          headers: parseHeaders(message.headers.toString('utf8')),
        };
      }
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch one full message.
   *
   * Reached only when all three header tiers failed on this specific message.
   * `BODY.PEEK[]` again: reading a message to look for an unsubscribe link must
   * not change what the mailbox says about it.
   */
  async fetchBody(folder: string, uid: number): Promise<string> {
    const client = this.require();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const download = await client.download(String(uid), undefined, { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of download.content) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      lock.release();
    }
  }

  /**
   * Send a `mailto:` unsubscribe through the authenticated account.
   *
   * SMTP is derived from the IMAP host by convention (`imap.` → `smtp.`), which
   * is right for Gmail, Fastmail and most hosts. It is a separate connection
   * opened per send and closed immediately: this happens a handful of times a
   * year and a pooled transport would just be state to go stale.
   */
  async send(message: {
    to: string;
    subject: string;
    body: string;
  }): Promise<SentMessage> {
    const transport = nodemailer.createTransport({
      host: this.config.host.replace(/^imap\./, 'smtp.'),
      port: 465,
      secure: true,
      auth: { user: this.config.user, pass: this.config.password },
    });
    try {
      const info = await transport.sendMail({
        from: this.config.user,
        to: message.to,
        subject: message.subject,
        text: message.body,
      });
      return { messageId: info.messageId };
    } finally {
      transport.close();
    }
  }

  private require(): ImapFlow {
    if (this.client === undefined) {
      throw new Error('Not connected. Call connect() first.');
    }
    return this.client;
  }
}

/**
 * Check that a credential works, without syncing anything.
 *
 * `unsub auth` calls this so a wrong app password is reported at the moment it
 * is entered rather than at the start of the next sync, four months later.
 */
export async function verifyImapCredentials(config: ImapConfig): Promise<void> {
  const provider = new ImapProvider(config);
  await provider.connect();
  try {
    await provider.listFolders();
  } finally {
    await provider.disconnect();
  }
}
