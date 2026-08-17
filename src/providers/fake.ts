import { splitMessage } from '../detection/mime.js';
import type {
  FetchRange,
  FetchedHeaders,
  FolderStatus,
  MailProvider,
  SentMessage,
} from './types.js';

/**
 * An in-memory `MailProvider` built from raw `.eml` text.
 *
 * This is the provider the integration tests run against. It exists so the sync
 * engine can be tested for the things that actually matter — resumability,
 * idempotency, `UIDVALIDITY` changes — without a network, a server, or a real
 * mailbox, and so those tests still pass in four months.
 */

export interface FakeMessage {
  /** Raw RFC 5322 text. */
  raw: string;
  uid: number;
  internalDate: Date;
}

export interface FakeFolder {
  uidValidity: number;
  messages: FakeMessage[];
}

export class FakeMailProvider implements MailProvider {
  readonly description = 'fake in-memory provider';

  connected = false;

  /** Every body fetched, so a test can assert the headers-only promise. */
  readonly bodyFetches: Array<{ folder: string; uid: number }> = [];
  /** Every message the provider was asked to send. */
  readonly sent: Array<{ to: string; subject: string; body: string }> = [];

  /**
   * Throw after this many messages have been yielded, simulating the user
   * hitting Ctrl-C or the connection dropping mid-sync.
   */
  failAfterMessages: number | undefined;

  private yielded = 0;

  constructor(private readonly folders: Map<string, FakeFolder>) {}

  static from(
    folders: Record<string, { uidValidity: number; messages: FakeMessage[] }>,
  ): FakeMailProvider {
    return new FakeMailProvider(new Map(Object.entries(folders)));
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async listFolders(): Promise<string[]> {
    return [...this.folders.keys()];
  }

  async status(folder: string): Promise<FolderStatus> {
    const state = this.require(folder);
    const uids = state.messages.map((m) => m.uid);
    return {
      folder,
      uidValidity: state.uidValidity,
      uidNext: uids.length === 0 ? 1 : Math.max(...uids) + 1,
      messageCount: state.messages.length,
    };
  }

  async *fetchHeaders(folder: string, range: FetchRange): AsyncIterable<FetchedHeaders> {
    const state = this.require(folder);
    const ordered = [...state.messages].sort((a, b) => a.uid - b.uid);

    for (const message of ordered) {
      if (range.afterUid !== undefined && message.uid <= range.afterUid) continue;
      if (range.since !== undefined && message.internalDate < range.since) continue;

      if (
        this.failAfterMessages !== undefined &&
        this.yielded >= this.failAfterMessages
      ) {
        throw new Error('simulated interruption');
      }
      this.yielded += 1;

      yield {
        folder,
        uid: message.uid,
        uidValidity: state.uidValidity,
        internalDate: message.internalDate,
        headers: splitMessage(message.raw).headers,
      };
    }
  }

  async fetchBody(folder: string, uid: number): Promise<string> {
    this.bodyFetches.push({ folder, uid });
    const message = this.require(folder).messages.find((m) => m.uid === uid);
    if (message === undefined) {
      throw new Error(`No message with uid ${uid} in ${folder}`);
    }
    return message.raw;
  }

  async send(message: {
    to: string;
    subject: string;
    body: string;
  }): Promise<SentMessage> {
    this.sent.push(message);
    return { messageId: `<fake-${this.sent.length}@localhost>` };
  }

  /** Reset the interruption counter so a killed sync can be re-run. */
  resume(): void {
    this.failAfterMessages = undefined;
    this.yielded = 0;
  }

  /** Simulate the server reassigning UIDs (ADR-001). */
  setUidValidity(folder: string, uidValidity: number): void {
    this.require(folder).uidValidity = uidValidity;
  }

  addMessage(folder: string, message: FakeMessage): void {
    this.require(folder).messages.push(message);
  }

  private require(folder: string): FakeFolder {
    const state = this.folders.get(folder);
    if (state === undefined) throw new Error(`No such folder: ${folder}`);
    return state;
  }
}
