import { spawn } from 'node:child_process';

import {
  buildKeepDecision,
  buildUnsubscribeDecision,
  buildUnsuppressDecision,
  keepConfirmation,
  suppressionStatus,
} from '../domain/decisions.js';
import {
  buildKept,
  buildReview,
  methodLabel,
  senderLabel,
  type AggregatedSender,
} from '../domain/review.js';
import {
  formatDate,
  parseDuration,
  parseInstant,
  type Duration,
} from '../domain/time.js';
import { verifyImapCredentials } from '../providers/imap.js';
import {
  aggregatedSenders,
  attemptsForSender,
  decisionsBySender,
  findSenders,
  latestAttempts,
} from '../storage/queries.js';
import {
  DecisionRepository,
  SenderRepository,
  SyncStateRepository,
} from '../storage/repository.js';
import { SyncEngine, type SyncOptions, type SyncResult } from '../sync/engine.js';
import {
  executeUnsubscribe,
  isStillSending,
  type ExecuteDependencies,
} from '../unsubscribe/execute.js';
import { UserFacingError, writeConfig, type Context } from './context.js';
import { describeStatus, renderKept, renderProgress, renderReview } from './render.js';

/**
 * The commands, as functions returning what to print.
 *
 * Kept separate from `index.ts` so each one is testable without spawning a
 * process or parsing argv, and so the interface stays a thin shell over the
 * domain layer (ADR-003).
 */

export interface Io {
  out(line: string): void;
  /** Progress that overwrites itself; falls back to `out` when not a TTY. */
  progress(line: string): void;
  prompt(question: PromptRequest): Promise<string>;
}

export interface PromptRequest {
  message: string;
  choices?: Array<{ name: string; value: string }>;
  default?: string;
}

/* -------------------------------------------------------------------------- */
/* auth                                                                        */
/* -------------------------------------------------------------------------- */

export interface AuthOptions {
  host?: string | undefined;
  port?: number | undefined;
  user?: string | undefined;
  folders?: string[] | undefined;
  password?: string | undefined;
  /** Skip the live connection check. */
  skipVerify?: boolean | undefined;
}

export async function auth(
  context: Context,
  options: AuthOptions,
  io: Io,
): Promise<void> {
  const user =
    options.user ??
    context.config?.user ??
    (await io.prompt({ message: 'Email address' }));
  const host =
    options.host ??
    context.config?.host ??
    (await io.prompt({ message: 'IMAP host', default: guessHost(user) }));
  const port = options.port ?? context.config?.port ?? 993;
  const folders = options.folders ?? context.config?.folders ?? ['INBOX'];

  // Prompted, never taken as a command-line argument: an app password passed as
  // an argv would land in shell history and in the process list.
  const password =
    options.password ??
    (await io.prompt({ message: `App password for ${user} (input is hidden)` }));

  if (password.trim().length === 0) {
    throw new UserFacingError('No password entered; nothing was stored.');
  }

  if (options.skipVerify !== true) {
    io.out(`  Checking ${user}@${host}:${port} …`);
    try {
      await verifyImapCredentials({ host, port, user, password: password.trim() });
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      throw new UserFacingError(
        `Could not sign in to ${host} as ${user}: ${reason}\n` +
          '  Nothing was stored. If this is a Google account, check that 2-Step\n' +
          '  Verification is on and that you pasted an app password, not your\n' +
          '  normal one.',
      );
    }
  }

  writeConfig({ host, port, user, folders });
  const location = await context.credentials.set(user, password.trim());

  io.out(`  Signed in as ${user}.`);
  io.out(
    location === 'keychain'
      ? '  Password stored in your OS keychain.'
      : `  No OS keychain available, so the password is in ${context.paths.dataDir}/credentials.json (mode 0600).`,
  );
  io.out(`  Folders to scan: ${folders.join(', ')}`);
  io.out('  Next: run `unsub review`.');
}

function guessHost(address: string): string {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  if (/(^|\.)(gmail\.com|googlemail\.com)$/.test(domain)) return 'imap.gmail.com';
  if (/(^|\.)fastmail\.com$/.test(domain)) return 'imap.fastmail.com';
  if (/(^|\.)(outlook|hotmail|live)\.com$/.test(domain)) return 'outlook.office365.com';
  if (/(^|\.)icloud\.com$/.test(domain)) return 'imap.mail.me.com';
  return domain.length > 0 ? `imap.${domain}` : '';
}

/* -------------------------------------------------------------------------- */
/* sync                                                                        */
/* -------------------------------------------------------------------------- */

export interface SyncCommandOptions {
  since?: Date | undefined;
  folders?: string[] | undefined;
  scrapeBodies?: boolean | undefined;
  quiet?: boolean | undefined;
}

export async function sync(
  context: Context,
  options: SyncCommandOptions,
  io: Io,
): Promise<SyncResult> {
  const provider = await context.mailProvider();
  const engine = new SyncEngine(context.db, provider, context.clock);

  const syncOptions: SyncOptions = {
    folders: options.folders ?? context.config?.folders,
    since: options.since,
    scrapeBodies: options.scrapeBodies ?? true,
    onProgress: (p) => {
      if (options.quiet === true) return;
      if (p.phase === 'folder-complete') {
        io.out(
          `  ${p.folder}: ${p.examined} scanned, ${p.detected} with an unsubscribe signal.`,
        );
      } else {
        io.progress(renderProgress(p.folder, p.examined, p.detected, p.estimatedTotal));
      }
    },
  };

  await provider.connect();
  try {
    const result = await engine.sync(syncOptions);

    if (result.interrupted) {
      io.out('');
      io.out(
        `  Sync stopped early: ${result.error?.message ?? 'unknown error'}\n` +
          '  Everything scanned before that point was saved. Run `unsub sync` again to\n' +
          '  pick up where it left off — re-running is safe and cannot double-count.',
      );
    }
    for (const folder of result.folders) {
      if (folder.uidValidityChanged) {
        io.out(
          `  ${folder.folder}: the server reassigned message IDs (UIDVALIDITY changed), ` +
            'so it was rescanned from scratch. No duplicates were created.',
        );
      }
    }
    return result;
  } finally {
    await provider.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* review                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReviewOptions {
  includeSuppressed?: boolean | undefined;
  limit?: number | undefined;
  /** Skip the sync that normally precedes rendering. */
  noSync?: boolean | undefined;
  since?: Date | undefined;
  /** Print the list and stop, without asking for decisions. */
  listOnly?: boolean | undefined;
  confirmSuspicious?: boolean | undefined;
  keepDuration?: Duration | undefined;
}

export async function review(
  context: Context,
  options: ReviewOptions,
  io: Io,
): Promise<void> {
  if (options.noSync !== true) {
    io.out('  Syncing new mail…');
    await sync(context, { since: options.since }, io);
    io.out('');
  }

  await reportFollowUps(context, io);

  const list = buildReview(
    aggregatedSenders(context.db),
    decisionsBySender(context.db),
    context.clock,
    {
      includeSuppressed: options.includeSuppressed,
      limit: options.limit,
    },
  );

  io.out(renderReview(list));
  io.out('');

  if (options.listOnly === true || list.senders.length === 0) return;

  const decisions = new DecisionRepository(context.db);

  for (const sender of list.senders) {
    const label = senderLabel(sender);
    const answer = await io.prompt({
      message:
        `${label} — ${sender.messageCount} messages, last ${formatDate(parseInstant(sender.lastSeen))}, ` +
        `${methodLabel(sender.method)}${sender.suspicious ? ' ⚠ suspicious target' : ''}`,
      choices: [
        { name: 'Keep receiving (hidden for 3 months)', value: 'keep' },
        { name: 'Unsubscribe', value: 'unsubscribe' },
        { name: 'Skip for now', value: 'skip' },
        { name: 'Split this sender apart first', value: 'split' },
        { name: 'Stop reviewing', value: 'quit' },
      ],
      default: 'skip',
    });

    if (answer === 'quit') break;
    if (answer === 'skip') continue;

    if (answer === 'split') {
      // The affordance ADR-005 requires: fix an over-merge while it is still
      // free, before a decision is recorded against the wrong grouping.
      io.out(
        `  Run \`unsub split ${sender.senderId.slice(0, 8)}\` to undo a merge on this sender, ` +
          'then review again.',
      );
      continue;
    }

    if (answer === 'keep') {
      const decision = buildKeepDecision(
        { senderId: sender.senderId, duration: options.keepDuration },
        context.clock,
      );
      decisions.append(decision);
      io.out('  ' + keepConfirmation(label, decision));
      continue;
    }

    await unsubscribeSender(context, sender, options.confirmSuspicious === true, io);
  }
}

async function unsubscribeSender(
  context: Context,
  sender: AggregatedSender,
  confirmSuspicious: boolean,
  io: Io,
): Promise<void> {
  const label = senderLabel(sender);

  if (sender.method === null || sender.unsubscribeUri === null) {
    io.out(`  No unsubscribe method known for ${label}; nothing was done.`);
    return;
  }

  let provider;
  try {
    provider = sender.method === 'mailto' ? await context.mailProvider() : undefined;
  } catch {
    provider = undefined;
  }

  const deps: ExecuteDependencies = {
    clock: context.clock,
    openBrowser,
    provider,
  };

  if (provider !== undefined) await provider.connect();
  try {
    const attempt = await executeUnsubscribe(
      {
        senderId: sender.senderId,
        senderLabel: label,
        method: sender.method,
        uri: sender.unsubscribeUri,
        suspicious: sender.suspicious,
        confirmSuspicious,
      },
      deps,
    );

    context.db
      .prepare(
        `INSERT INTO unsubscribe_attempt
           (sender_id, method, attempted_at, result, http_status, target_uri,
            sent_message_id, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.senderId,
        attempt.method,
        attempt.attemptedAt,
        attempt.result,
        attempt.httpStatus ?? null,
        attempt.targetUri ?? null,
        attempt.sentMessageId ?? null,
        attempt.error ?? null,
      );

    // A skipped suspicious sender was not unsubscribed, so it must stay on the
    // review list rather than being recorded as decided.
    if (attempt.result !== 'skipped_suspicious') {
      new DecisionRepository(context.db).append(
        buildUnsubscribeDecision(sender.senderId, context.clock),
      );
    }

    io.out('  ' + attempt.message);
  } finally {
    if (provider !== undefined) await provider.disconnect();
  }
}

/**
 * Report on unsubscribes that need a human answer, before the review list.
 *
 * Two cases: a link we opened in the browser and never learned the outcome of,
 * and a sender still sending more than ten days after we unsubscribed.
 */
async function reportFollowUps(context: Context, io: Io): Promise<void> {
  const senders = new Map(aggregatedSenders(context.db).map((s) => [s.senderId, s]));
  const attempts = latestAttempts(context.db);
  const lines: string[] = [];

  for (const [senderId, attempt] of attempts) {
    const sender = senders.get(senderId);
    if (sender === undefined) continue;
    const label = senderLabel(sender);

    if (attempt.result === 'pending_manual') {
      lines.push(
        `  ${label}: you opened its unsubscribe page on ${formatDate(parseInstant(attempt.attemptedAt))}. ` +
          'Did it work? If mail keeps arriving it will reappear below.',
      );
    }

    if (
      attempt.result === 'success' &&
      isStillSending(parseInstant(attempt.attemptedAt), parseInstant(sender.lastSeen))
    ) {
      lines.push(
        `  ${label}: still sending. You unsubscribed on ${formatDate(parseInstant(attempt.attemptedAt))} ` +
          `and mail arrived as recently as ${formatDate(parseInstant(sender.lastSeen))} — ` +
          'more than the ten days CAN-SPAM allows.',
      );
    }
  }

  if (lines.length > 0) {
    io.out('  Follow-ups');
    io.out('  ──────────');
    for (const line of lines) io.out(line);
    io.out('');
  }
}

/* -------------------------------------------------------------------------- */
/* kept                                                                        */
/* -------------------------------------------------------------------------- */

export function kept(context: Context, io: Io): void {
  io.out(
    renderKept(
      buildKept(
        aggregatedSenders(context.db),
        decisionsBySender(context.db),
        context.clock,
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* unsuppress                                                                  */
/* -------------------------------------------------------------------------- */

export function unsuppress(context: Context, reference: string, io: Io): void {
  const sender = requireOne(context, reference);
  const decisions = new DecisionRepository(context.db);

  // Appending an unsuppress for a sender that was never held would put an event
  // in the log that explains nothing, which is the opposite of what the log is
  // for. Say what the actual state is instead.
  const current = suppressionStatus(decisions.forSender(sender.senderId), context.clock);
  if (current.state !== 'suppressed' && current.state !== 'suppressed_forever') {
    throw new UserFacingError(
      `${senderLabel(sender)} is not currently kept, so there is no hold to end.\n` +
        `  Its state is: ${describeStatus(current)}.`,
    );
  }

  decisions.append(buildUnsuppressDecision(sender.senderId, context.clock));
  io.out(
    `  Hold ended for ${senderLabel(sender)}. It will appear in your next review.\n` +
      '  The original Keep is still in the log, so the history stays readable.',
  );
}

/* -------------------------------------------------------------------------- */
/* merge / split                                                               */
/* -------------------------------------------------------------------------- */

export function merge(
  context: Context,
  sourceRef: string,
  targetRef: string,
  io: Io,
): void {
  const source = requireOne(context, sourceRef);
  const target = requireOne(context, targetRef);
  if (source.senderId === target.senderId) {
    throw new UserFacingError('Those are already the same sender.');
  }

  new SenderRepository(context.db, context.clock).merge(source.senderId, target.senderId);
  io.out(
    `  Merged ${senderLabel(source)} into ${senderLabel(target)}.\n` +
      '  This merge is recorded and will be replayed if the grouping rules ever change.',
  );
}

export function split(context: Context, reference: string, io: Io): void {
  const sender = requireOne(context, reference);
  const senders = new SenderRepository(context.db, context.clock);
  const row = senders.get(sender.senderId);

  if (row?.mergedInto == null) {
    throw new UserFacingError(
      `${senderLabel(sender)} is not the result of a merge, so there is nothing to split.\n` +
        '  Senders are only ever combined by an explicit `unsub merge`.',
    );
  }

  senders.unmerge(sender.senderId);
  io.out(
    `  Split ${senderLabel(sender)} back out. Both will appear in your next review.`,
  );
}

/* -------------------------------------------------------------------------- */
/* status                                                                      */
/* -------------------------------------------------------------------------- */

export async function status(
  context: Context,
  reference: string | undefined,
  io: Io,
): Promise<void> {
  if (reference !== undefined) {
    statusForSender(context, reference, io);
    return;
  }

  const senders = aggregatedSenders(context.db);
  const decisions = decisionsBySender(context.db);
  const list = buildReview(senders, decisions, context.clock, {});

  io.out(`  Mailbox      ${context.config?.user ?? 'not configured — run `unsub auth`'}`);
  if (context.config !== undefined) {
    const location = await context.credentials.locate(context.config.user);
    io.out(
      `  Credential   ${
        location === 'keychain'
          ? 'OS keychain'
          : location === 'file'
            ? `${context.paths.dataDir}/credentials.json (0600)`
            : 'not stored — run `unsub auth`'
      }`,
    );
  }
  io.out(`  Database     ${context.paths.database}`);
  io.out('');

  const watermarks = new SyncStateRepository(context.db).all();
  if (watermarks.length === 0) {
    io.out('  Never synced. Run `unsub review` or `unsub sync`.');
  } else {
    io.out('  Last sync');
    for (const watermark of watermarks) {
      io.out(
        `    ${watermark.folder}: up to UID ${watermark.lastUid} ` +
          `(UIDVALIDITY ${watermark.uidvalidity}) on ${formatDate(parseInstant(watermark.lastSyncedAt))}`,
      );
    }
  }
  io.out('');

  const messages =
    context.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM message').get()?.n ??
    0;

  io.out(
    `  ${senders.length} senders with an unsubscribe signal, from ${messages} messages`,
  );
  io.out(`  ${list.senders.length} awaiting a decision`);
  io.out('  ' + list.footer);
}

function statusForSender(context: Context, reference: string, io: Io): void {
  const sender = requireOne(context, reference);
  const senders = new SenderRepository(context.db, context.clock);
  const log = new DecisionRepository(context.db).forSender(sender.senderId);

  io.out(`  ${senderLabel(sender)}`);
  io.out(`  id           ${sender.senderId}`);
  io.out(`  address      ${sender.displayAddress ?? '—'}`);
  io.out(`  messages     ${sender.messageCount}`);
  io.out(
    `  seen         ${formatDate(parseInstant(sender.firstSeen))} → ${formatDate(parseInstant(sender.lastSeen))}`,
  );
  io.out(
    `  method       ${methodLabel(sender.method)}${sender.suspicious ? ' ⚠ target domain unrelated to sender' : ''}`,
  );
  if (sender.unsubscribeUri != null) io.out(`  target       ${sender.unsubscribeUri}`);
  io.out(`  state        ${describeStatus(suppressionStatus(log, context.clock))}`);

  io.out('');
  io.out('  Identities');
  for (const identity of senders.identitiesOf(sender.senderId)) {
    io.out(`    ${identity.kind}: ${identity.value}`);
  }

  if (log.length > 0) {
    io.out('');
    io.out('  Decisions (append-only)');
    for (const entry of log) {
      const until =
        entry.decision === 'keep'
          ? entry.suppressedUntil === null
            ? ' → forever'
            : ` → until ${formatDate(parseInstant(entry.suppressedUntil))}`
          : '';
      io.out(
        `    ${formatDate(parseInstant(entry.decidedAt))}  ${entry.decision}${until}`,
      );
    }
  }

  const attempts = attemptsForSender(context.db, sender.senderId);
  if (attempts.length > 0) {
    io.out('');
    io.out('  Unsubscribe attempts');
    for (const attempt of attempts) {
      const detail =
        attempt.httpStatus != null
          ? ` (HTTP ${attempt.httpStatus})`
          : attempt.error != null
            ? ` (${attempt.error})`
            : '';
      io.out(
        `    ${formatDate(parseInstant(attempt.attemptedAt))}  ${attempt.method}: ${attempt.result}${detail}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function requireOne(context: Context, reference: string): AggregatedSender {
  const matches = findSenders(context.db, reference);
  if (matches.length === 0) {
    throw new UserFacingError(`No sender matches "${reference}".`);
  }
  if (matches.length > 1) {
    const listing = matches
      .slice(0, 8)
      .map(
        (s) =>
          `    ${s.senderId.slice(0, 8)}  ${senderLabel(s)} <${s.displayAddress ?? ''}>`,
      )
      .join('\n');
    throw new UserFacingError(
      `"${reference}" matches ${matches.length} senders. Use one of these ids:\n${listing}`,
    );
  }
  return matches[0] as AggregatedSender;
}

/** Parse `--for 6m` / `--forever` into a suppression window. */
export function keepDurationFrom(
  forValue: string | undefined,
  forever: boolean | undefined,
): Duration | undefined {
  if (forever === true) return 'forever';
  if (forValue === undefined) return undefined;
  return parseDuration(forValue);
}

/** Open a URL in the user's browser, per platform. */
export async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', reject);
    child.unref();
    resolve();
  });
}
