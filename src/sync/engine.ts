import { detect, type Detection } from '../detection/detect.js';
import {
  decodeParts,
  header,
  parseAddress,
  splitMessage,
  type Headers,
} from '../detection/mime.js';
import type { Clock } from '../domain/clock.js';
import { candidateIdentities, resolveSender } from '../domain/identity.js';
import { addMonths, toIso } from '../domain/time.js';
import type { FetchedHeaders, MailProvider } from '../providers/types.js';
import type { Db } from '../storage/db.js';
import {
  MessageRepository,
  SenderRepository,
  SyncStateRepository,
} from '../storage/repository.js';

/**
 * The sync engine.
 *
 * Three properties matter, and they are the ones ADR-002 calls out:
 *
 *   **Resumable.** Progress is committed per batch as it is made. Interruption
 *   is the common case here, not the rare one, so a killed sync keeps what it
 *   already learned and picks up from its watermark.
 *
 *   **Idempotent.** Messages are keyed by Message-ID and inserted with
 *   `INSERT OR IGNORE`; per-sender counts are `COUNT(*)` queries rather than
 *   maintained counters. There is no counter for a re-run to double.
 *
 *   **`UIDVALIDITY`-aware.** A change means every stored UID for that folder is
 *   meaningless, so the watermark is discarded and the folder resynced. The
 *   message rows survive, because they are keyed by Message-ID.
 */

/** How far back a first run goes when `--since` is not given (ADR-002). */
export const DEFAULT_BACKFILL_MONTHS = 12;

/** Messages per committed batch. Small enough that a kill loses little. */
export const BATCH_SIZE = 50;

export interface SyncProgress {
  folder: string;
  /** Messages examined so far in this folder. */
  examined: number;
  /** Messages found to carry an unsubscribe signal. */
  detected: number;
  /** Best-effort total for this folder, for a progress bar. */
  estimatedTotal: number;
  phase: 'scanning' | 'folder-complete';
}

export interface SyncOptions {
  folders?: readonly string[] | undefined;
  /** Backfill window start. Defaults to 12 months before now. */
  since?: Date | undefined;
  /** Fetch full bodies when the headers are inconclusive (tier 4). */
  scrapeBodies?: boolean | undefined;
  onProgress?: ((progress: SyncProgress) => void) | undefined;
}

export interface FolderResult {
  folder: string;
  examined: number;
  detected: number;
  recorded: number;
  bodiesFetched: number;
  uidValidityChanged: boolean;
  lastUid: number;
}

export interface SyncResult {
  folders: FolderResult[];
  examined: number;
  recorded: number;
  /** True when the run ended early. What was committed is still valid. */
  interrupted: boolean;
  error?: Error | undefined;
}

export class SyncEngine {
  private readonly senders: SenderRepository;
  private readonly messages: MessageRepository;
  private readonly state: SyncStateRepository;

  constructor(
    private readonly db: Db,
    private readonly provider: MailProvider,
    private readonly clock: Clock,
  ) {
    this.senders = new SenderRepository(db, clock);
    this.messages = new MessageRepository(db, clock);
    this.state = new SyncStateRepository(db);
  }

  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const folders = options.folders ?? (await this.provider.listFolders());
    const since = options.since ?? addMonths(this.clock.now(), -DEFAULT_BACKFILL_MONTHS);

    const results: FolderResult[] = [];
    let interrupted = false;
    let error: Error | undefined;

    for (const folder of folders) {
      try {
        results.push(await this.syncFolder(folder, since, options));
      } catch (caught) {
        // Whatever was committed before this point stays committed. Re-running
        // resumes from the watermark; it does not start over.
        interrupted = true;
        error = caught instanceof Error ? caught : new Error(String(caught));
        break;
      }
    }

    return {
      folders: results,
      examined: results.reduce((n, r) => n + r.examined, 0),
      recorded: results.reduce((n, r) => n + r.recorded, 0),
      interrupted,
      error,
    };
  }

  private async syncFolder(
    folder: string,
    since: Date,
    options: SyncOptions,
  ): Promise<FolderResult> {
    const status = await this.provider.status(folder);
    const stored = this.state.get(folder);

    // ADR-001: a UIDVALIDITY change invalidates every UID we hold for this
    // folder. Discard the watermark and resync; the messages themselves are
    // keyed by Message-ID, so they are re-attached rather than duplicated.
    const uidValidityChanged =
      stored !== undefined && stored.uidvalidity !== status.uidValidity;
    if (uidValidityChanged) this.state.reset(folder);

    const watermark = uidValidityChanged ? undefined : stored;

    // A wider --since than last time means going back further, so the
    // resume-from-UID optimisation does not apply.
    const widened =
      watermark?.backfillSince != null && new Date(watermark.backfillSince) > since;

    const range = {
      afterUid: widened ? undefined : watermark?.lastUid,
      since,
    };

    const result: FolderResult = {
      folder,
      examined: 0,
      detected: 0,
      recorded: 0,
      bodiesFetched: 0,
      uidValidityChanged,
      lastUid: widened ? 0 : (watermark?.lastUid ?? 0),
    };

    const backfillSince = toIso(
      widened || watermark?.backfillSince == null
        ? since
        : new Date(watermark.backfillSince),
    );

    let batch: Array<{
      fetched: FetchedHeaders;
      detection: Detection;
      headers: Headers;
    }> = [];

    const commit = (): void => {
      if (batch.length === 0) return;
      const pending = batch;
      batch = [];
      this.db.transaction(() => {
        for (const item of pending) {
          if (this.ingest(item.fetched, item.headers, item.detection)) {
            result.recorded += 1;
          }
        }
        // The watermark advances only inside the same transaction that stored
        // the messages, so a crash can cause re-work but never a gap.
        this.state.save({
          folder,
          uidvalidity: status.uidValidity,
          lastUid: result.lastUid,
          lastSyncedAt: toIso(this.clock.now()),
          backfillSince,
        });
      })();
    };

    for await (const fetched of this.provider.fetchHeaders(folder, range)) {
      result.examined += 1;
      result.lastUid = Math.max(result.lastUid, fetched.uid);

      let headers = fetched.headers;
      let detection = detect({ headers });

      // Tier 4 is the only tier that costs a body fetch, so it only runs when
      // all three header tiers have already failed on this specific message.
      if (detection === undefined && options.scrapeBodies === true) {
        const raw = await this.provider.fetchBody(folder, fetched.uid);
        result.bodiesFetched += 1;
        const parsed = splitMessage(raw);
        headers = mergeHeaders(headers, parsed.headers);
        detection = detect({
          headers,
          parts: decodeParts(parsed.headers, parsed.body),
        });
      }

      if (detection !== undefined) {
        result.detected += 1;
        batch.push({ fetched, detection, headers });
      }

      if (batch.length >= BATCH_SIZE) commit();

      options.onProgress?.({
        folder,
        examined: result.examined,
        detected: result.detected,
        estimatedTotal: status.messageCount,
        phase: 'scanning',
      });
    }

    commit();

    // An empty folder, or one where nothing matched, still needs its watermark
    // advanced — otherwise every run rescans it from scratch.
    if (result.recorded === 0) {
      this.state.save({
        folder,
        uidvalidity: status.uidValidity,
        lastUid: result.lastUid,
        lastSyncedAt: toIso(this.clock.now()),
        backfillSince,
      });
    }

    options.onProgress?.({
      folder,
      examined: result.examined,
      detected: result.detected,
      estimatedTotal: status.messageCount,
      phase: 'folder-complete',
    });

    return result;
  }

  /** Resolve the sender and record the message. Returns true if it was new. */
  private ingest(
    fetched: FetchedHeaders,
    headers: Headers,
    detection: Detection,
  ): boolean {
    const from = parseAddress(header(headers, 'from'));
    const listId = header(headers, 'list-id');
    const seenAt = toIso(fetched.internalDate);

    const candidates = candidateIdentities({
      fromAddress: from.address,
      fromName: from.name,
      listId,
      dkimDomains: dkimOf(headers),
    });

    const resolution = resolveSender(candidates, this.senders.findMatches(candidates));

    let senderId: string;
    if (resolution.kind === 'new') {
      senderId = this.senders.create({
        displayName: from.name,
        displayAddress: from.address,
        seenAt,
      });
      this.senders.addIdentities(senderId, resolution.identities, seenAt);
    } else {
      senderId = resolution.senderId;
      this.senders.addIdentities(senderId, resolution.newIdentities, seenAt);
    }

    this.senders.touch(senderId, seenAt, { name: from.name, address: from.address });

    return this.messages.record({
      // Message-ID where the sender gave one, so the same message seen in two
      // folders is one row. The synthetic fallback is folder-scoped, which is
      // the best available when there is no Message-ID at all.
      id:
        header(headers, 'message-id')?.trim() ??
        `${fetched.folder}:${fetched.uidValidity}:${fetched.uid}`,
      senderId,
      folder: fetched.folder,
      uidvalidity: fetched.uidValidity,
      uid: fetched.uid,
      receivedAt: seenAt,
      subject: header(headers, 'subject'),
      fromName: from.name,
      fromAddress: from.address,
      listId,
      method: detection.method,
      confidence: detection.confidence,
      unsubscribeUri: detection.uri,
      suspicious: detection.suspicious,
    });
  }
}

function dkimOf(headers: Headers): string[] {
  return (headers.get('dkim-signature') ?? []).flatMap((signature) => {
    const match = /(?:^|[;\s])d=([^;\s]+)/i.exec(signature);
    const value = match?.[1]?.trim().toLowerCase();
    return value === undefined || value.length === 0 ? [] : [value];
  });
}

/** Headers from a full fetch win, since a header-only fetch is a subset. */
function mergeHeaders(partial: Headers, full: Headers): Headers {
  const merged: Headers = new Map(partial);
  for (const [key, values] of full) merged.set(key, values);
  return merged;
}
