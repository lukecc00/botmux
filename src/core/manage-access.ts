import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { platformMachineBaseUrl, publicReverseProxyBaseUrl } from '../platform/binding.js';

const DASHBOARD_DIR = join(homedir(), '.botmux');

function readTrimmed(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** Private owner-only management entry. Platform routes rely on platform SSO;
 * local/self-hosted routes carry the dashboard token because the surrounding
 * card is delivered only through ephemeral/DM private channels. */
export function buildManagementDashboardUrl(): string {
  const platformBase = platformMachineBaseUrl();
  if (platformBase) return `${platformBase}/#/bot-defaults`;

  const publicBase = publicReverseProxyBaseUrl();
  const port = readTrimmed(join(DASHBOARD_DIR, '.dashboard-port')) ?? String(config.dashboard.port);
  const token = readTrimmed(join(DASHBOARD_DIR, '.dashboard-token'));
  const origin = publicBase ?? `http://${config.dashboard.externalHost}:${port}`;
  const auth = token ? `/?t=${encodeURIComponent(token)}` : '/';
  return `${origin}${auth}#/bot-defaults`;
}
