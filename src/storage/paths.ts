import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * Where the database and config live (ADR-004).
 *
 * `UNSUB_DATA_DIR` overrides everything. Tests rely on it, and so does anyone
 * who keeps their dotfiles somewhere unusual.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['UNSUB_DATA_DIR'];
  if (override !== undefined && override !== '') return override;

  const app = 'unsubscribe-manager';
  switch (platform()) {
    case 'win32': {
      const appData = env['APPDATA'];
      return appData !== undefined && appData !== ''
        ? join(appData, app)
        : join(homedir(), 'AppData', 'Roaming', app);
    }
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', app);
    default: {
      const xdg = env['XDG_CONFIG_HOME'];
      return xdg !== undefined && xdg !== ''
        ? join(xdg, app)
        : join(homedir(), '.config', app);
    }
  }
}

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'unsubscribe.db');
}

/** Fallback credential file, used only when no OS keychain is available. */
export function credentialFallbackPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'credentials.json');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'config.json');
}
