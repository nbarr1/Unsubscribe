import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { systemClock, type Clock } from '../domain/clock.js';
import { OsCredentialStore, type CredentialStore } from '../providers/credentials.js';
import { ImapProvider, type ImapConfig } from '../providers/imap.js';
import type { MailProvider } from '../providers/types.js';
import { openDatabase, type Db } from '../storage/db.js';
import { configPath, dataDir, databasePath } from '../storage/paths.js';

/**
 * What every command needs: a database, a clock, and — for the two commands
 * that talk to a mailbox — a provider.
 *
 * The provider is built lazily. `review`, `kept`, `status`, `merge` and
 * `split` must all work with the network down and the credential missing:
 * being unable to reach the mailbox should not stop the user reading what they
 * already decided.
 */

export interface AppConfig {
  host: string;
  port: number;
  user: string;
  folders: string[];
}

export const DEFAULT_FOLDERS = ['INBOX'];

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig | undefined {
  const path = configPath(env);
  const fromFile: Partial<AppConfig> = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<AppConfig>)
    : {};

  // Environment overrides the file, so a one-off run can point elsewhere.
  const host = env['UNSUB_IMAP_HOST'] ?? fromFile.host;
  const user = env['UNSUB_IMAP_USER'] ?? fromFile.user;
  if (host === undefined || user === undefined) return undefined;

  const port = Number(env['UNSUB_IMAP_PORT'] ?? fromFile.port ?? 993);
  const folders =
    env['UNSUB_IMAP_FOLDERS']
      ?.split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0) ??
    fromFile.folders ??
    DEFAULT_FOLDERS;

  return { host, port, user, folders };
}

export function writeConfig(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  mkdirSync(dataDir(env), { recursive: true });
  // No secret goes in here — only the address and the host (ADR-001).
  writeFileSync(configPath(env), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export interface Context {
  db: Db;
  clock: Clock;
  credentials: CredentialStore;
  config: AppConfig | undefined;
  paths: { dataDir: string; database: string; config: string };
  mailProvider(): Promise<MailProvider>;
  close(): void;
}

export interface ContextOptions {
  clock?: Clock;
  db?: Db;
  credentials?: CredentialStore;
  /** Injected by tests so the CLI can run against the fake provider. */
  provider?: MailProvider | undefined;
  env?: NodeJS.ProcessEnv;
}

export function createContext(options: ContextOptions = {}): Context {
  const env = options.env ?? process.env;
  const db = options.db ?? openDatabase({ path: databasePath(env) });
  const credentials = options.credentials ?? new OsCredentialStore();
  const config = readConfig(env);

  return {
    db,
    clock: options.clock ?? systemClock,
    credentials,
    config,
    paths: {
      dataDir: dataDir(env),
      database: databasePath(env),
      config: configPath(env),
    },

    async mailProvider(): Promise<MailProvider> {
      if (options.provider !== undefined) return options.provider;
      if (config === undefined) {
        throw new UserFacingError('No mailbox configured yet. Run `unsub auth` first.');
      }
      const password = await credentials.get(config.user);
      if (password === undefined) {
        throw new UserFacingError(
          `No stored credential for ${config.user}. Run \`unsub auth\` to add one.`,
        );
      }
      const imapConfig: ImapConfig = {
        host: config.host,
        port: config.port,
        user: config.user,
        password,
      };
      return new ImapProvider(imapConfig);
    },

    close(): void {
      if (options.db === undefined) db.close();
    },
  };
}

/**
 * An error whose message is meant for the user.
 *
 * These print as a plain sentence with no stack trace. A stack trace for
 * "you haven't run auth yet" is noise, and noise at the start of a session is
 * how a tool gets abandoned.
 */
export class UserFacingError extends Error {
  readonly userFacing = true;
}
