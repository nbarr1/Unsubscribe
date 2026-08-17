#!/usr/bin/env node
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';

import { addMonths } from '../domain/time.js';
import {
  auth,
  kept,
  keepDurationFrom,
  merge,
  review,
  split,
  status,
  sync,
  unsuppress,
  type Io,
} from './commands.js';
import { createContext, UserFacingError, type Context } from './context.js';

/**
 * Argument parsing and process wiring, and nothing else.
 *
 * All behaviour lives in `commands.ts`, which is why the commands can be tested
 * without spawning a process.
 */

const io: Io = {
  out(line: string): void {
    process.stdout.write(line + '\n');
  },

  progress(line: string): void {
    if (process.stdout.isTTY) {
      process.stdout.write('\r[2K' + line);
    }
    // Not a TTY: stay silent rather than filling a log file with progress bars.
    // The per-folder summary still prints.
  },

  async prompt(request): Promise<string> {
    // Imported lazily so that non-interactive commands do not pay for the
    // prompt library, and so a broken terminal only breaks the flow that needs
    // one.
    const { select, input, password } = await import('@inquirer/prompts');
    if (request.choices !== undefined) {
      return select({
        message: request.message,
        choices: request.choices,
        default: request.default,
      });
    }
    if (/password/i.test(request.message)) {
      return password({ message: request.message, mask: '•' });
    }
    return input({ message: request.message, default: request.default });
  },
};

function parseSince(value: string | undefined, context: Context): Date | undefined {
  if (value === undefined) return undefined;
  const relative = /^(\d+)\s*(d|m|y)$/i.exec(value.trim());
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? 'm').toLowerCase();
    const now = context.clock.now();
    if (unit === 'd') return new Date(now.getTime() - amount * 86_400_000);
    return addMonths(now, -(unit === 'y' ? amount * 12 : amount));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new UserFacingError(
      `Cannot read "${value}" as a date. Use an ISO date (2025-01-31) or a window (18m, 400d).`,
    );
  }
  return parsed;
}

async function withContext(
  run: (context: Context) => Promise<void> | void,
): Promise<void> {
  const context = createContext();
  try {
    await run(context);
  } finally {
    context.close();
  }
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('unsub')
    .description(
      'Find which senders offer an unsubscribe mechanism, and decide per sender\n' +
        'whether to keep receiving mail or to unsubscribe. Everything stays on this\n' +
        'machine: no server, no telemetry, and your mail is only ever read.',
    )
    .version('0.1.0');

  program
    .command('auth')
    .description('Store the mailbox credential in your OS keychain')
    .option('--user <address>', 'email address')
    .option('--host <host>', 'IMAP host (default: guessed from the address)')
    .option('--port <port>', 'IMAP port', (v) => Number(v))
    .option('--folders <list>', 'comma-separated folders to scan', (v) =>
      v.split(',').map((f) => f.trim()),
    )
    .option('--skip-verify', 'store without checking the credential first')
    .action(async (options) =>
      withContext((context) =>
        auth(
          context,
          {
            user: options.user,
            host: options.host,
            port: options.port,
            folders: options.folders,
            skipVerify: options.skipVerify,
          },
          io,
        ),
      ),
    );

  program
    .command('sync')
    .description('Fetch new mail and record unsubscribe signals')
    .option('--since <when>', 'backfill window, e.g. 18m, 400d, or 2025-01-31')
    .option('--folders <list>', 'comma-separated folders to scan', (v) =>
      v.split(',').map((f) => f.trim()),
    )
    .option('--no-scrape-bodies', 'headers only; skip body-scraped detection')
    .option('--quiet', 'no progress output')
    .action(async (options) =>
      withContext(async (context) => {
        await sync(
          context,
          {
            since: parseSince(options.since, context),
            folders: options.folders,
            scrapeBodies: options.scrapeBodies,
            quiet: options.quiet,
          },
          io,
        );
      }),
    );

  program
    .command('review')
    .description('Sync, then decide per sender: keep or unsubscribe')
    .option('--include-suppressed', 'also show senders you kept')
    .option('--limit <n>', 'show at most n senders', (v) => Number(v))
    .option('--no-sync', 'skip the sync and review what is already stored')
    .option('--since <when>', 'backfill window for the sync')
    .option('--list', 'print the list and exit without asking anything')
    .option('--for <duration>', 'hold length when keeping, e.g. 6m')
    .option('--forever', 'keep means never resurface')
    .option(
      '--confirm-suspicious',
      'allow acting on senders whose unsubscribe target is an unrelated domain',
    )
    .action(async (options) =>
      withContext((context) =>
        review(
          context,
          {
            includeSuppressed: options.includeSuppressed,
            limit: options.limit,
            noSync: options.sync === false,
            since: parseSince(options.since, context),
            listOnly: options.list,
            confirmSuspicious: options.confirmSuspicious,
            keepDuration: keepDurationFrom(options.for, options.forever),
          },
          io,
        ),
      ),
    );

  program
    .command('kept')
    .description('Show senders you kept, and exactly when each returns')
    .action(async () => withContext((context) => kept(context, io)));

  program
    .command('unsuppress <sender>')
    .description('End a keep early, so the sender returns to your next review')
    .action(async (sender: string) =>
      withContext((context) => unsuppress(context, sender, io)),
    );

  program
    .command('merge <source> <target>')
    .description('Treat two senders as one. Recorded, and replayed if rules change')
    .action(async (source: string, target: string) =>
      withContext((context) => merge(context, source, target, io)),
    );

  program
    .command('split <sender>')
    .description('Undo a merge you made earlier')
    .action(async (sender: string) =>
      withContext((context) => split(context, sender, io)),
    );

  program
    .command('status [sender]')
    .description('Show where things stand, or everything known about one sender')
    .action(async (sender: string | undefined) =>
      withContext((context) => status(context, sender, io)),
    );

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  try {
    await buildProgram().parseAsync(argv as string[]);
    return 0;
  } catch (caught) {
    if (caught instanceof UserFacingError) {
      // A plain sentence, no stack trace. Noise at the start of a session is
      // how a tool used six times a year gets abandoned.
      process.stderr.write(`\n  ${caught.message}\n\n`);
      return 1;
    }
    const message = caught instanceof Error ? caught.stack : String(caught);
    process.stderr.write(`\n  Unexpected error:\n${message}\n\n`);
    return 1;
  }
}

// Only run when invoked directly, so the module stays importable by tests.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then((code) => {
    process.exitCode = code;
  });
}
