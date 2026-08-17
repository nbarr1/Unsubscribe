import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { credentialFallbackPath } from '../storage/paths.js';

/**
 * Where the mail credential lives (ADR-001).
 *
 * The OS keychain first — macOS Keychain, GNOME Keyring / libsecret, Windows
 * Credential Vault — via `keytar`. On a machine with no keychain (a headless
 * Linux box, a container), a `0600` file in the config directory.
 *
 * Never in the repository. Never in a `.env` file that gets committed.
 *
 * `keytar` is loaded dynamically and its absence is not an error. It is a
 * native module, and a native module that fails to build after a Node upgrade
 * is exactly the kind of thing that turns "I'll do my unsubscribes this
 * afternoon" into an hour of yak-shaving. Falling back to a `0600` file keeps
 * the tool working; the fallback is reported, not hidden.
 */

const SERVICE = 'unsubscribe-manager';

export type CredentialLocation = 'keychain' | 'file' | 'absent';

export interface CredentialStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<CredentialLocation>;
  remove(account: string): Promise<boolean>;
  locate(account: string): Promise<CredentialLocation>;
}

interface Keytar {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let keytarPromise: Promise<Keytar | undefined> | undefined;

async function loadKeytar(): Promise<Keytar | undefined> {
  keytarPromise ??= import('keytar')
    .then((module) => (module.default ?? module) as unknown as Keytar)
    .catch(() => undefined);
  return keytarPromise;
}

/** Reset the cached keychain probe. Tests use this; nothing else should. */
export function resetKeychainProbe(): void {
  keytarPromise = undefined;
}

interface FileContents {
  [account: string]: string;
}

function readFallback(path: string): FileContents {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FileContents;
  } catch {
    return {};
  }
}

function writeFallback(path: string, contents: FileContents): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(contents, null, 2), { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already exists, so set it
  // explicitly. A world-readable credential file is not a fallback, it is a leak.
  chmodSync(path, 0o600);
}

export class OsCredentialStore implements CredentialStore {
  constructor(private readonly fallbackPath: string = credentialFallbackPath()) {}

  async get(account: string): Promise<string | undefined> {
    const keytar = await loadKeytar();
    if (keytar !== undefined) {
      try {
        const secret = await keytar.getPassword(SERVICE, account);
        if (secret != null && secret.length > 0) return secret;
      } catch {
        // Keychain present but unusable (locked, no session bus). Fall through.
      }
    }
    return readFallback(this.fallbackPath)[account];
  }

  async set(account: string, secret: string): Promise<CredentialLocation> {
    const keytar = await loadKeytar();
    if (keytar !== undefined) {
      try {
        await keytar.setPassword(SERVICE, account, secret);
        return 'keychain';
      } catch {
        // Fall through to the file.
      }
    }
    const contents = readFallback(this.fallbackPath);
    contents[account] = secret;
    writeFallback(this.fallbackPath, contents);
    return 'file';
  }

  async remove(account: string): Promise<boolean> {
    let removed = false;

    const keytar = await loadKeytar();
    if (keytar !== undefined) {
      try {
        removed = await keytar.deletePassword(SERVICE, account);
      } catch {
        // Ignore; still try the file.
      }
    }

    const contents = readFallback(this.fallbackPath);
    if (account in contents) {
      delete contents[account];
      if (Object.keys(contents).length === 0) {
        rmSync(this.fallbackPath, { force: true });
      } else {
        writeFallback(this.fallbackPath, contents);
      }
      removed = true;
    }
    return removed;
  }

  async locate(account: string): Promise<CredentialLocation> {
    const keytar = await loadKeytar();
    if (keytar !== undefined) {
      try {
        const secret = await keytar.getPassword(SERVICE, account);
        if (secret != null && secret.length > 0) return 'keychain';
      } catch {
        // Fall through.
      }
    }
    return account in readFallback(this.fallbackPath) ? 'file' : 'absent';
  }
}

/** An in-memory store, for tests. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly secrets = new Map<string, string>();

  async get(account: string): Promise<string | undefined> {
    return this.secrets.get(account);
  }

  async set(account: string, secret: string): Promise<CredentialLocation> {
    this.secrets.set(account, secret);
    return 'keychain';
  }

  async remove(account: string): Promise<boolean> {
    return this.secrets.delete(account);
  }

  async locate(account: string): Promise<CredentialLocation> {
    return this.secrets.has(account) ? 'keychain' : 'absent';
  }
}
