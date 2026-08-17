import { join } from 'node:path';
import type { ResolvedTopicGroupMemoryTencentDbConfig } from './topic-group-memory-config.js';
import { readSecureHostFileSync } from '../platform/secure-host-file.js';
import { resolveTencentDbRuntimeDir } from './tencentdb-agent-memory-client.js';

const USER_KEY_PATTERN = /^sk-mem-[A-Za-z0-9_-]{24,}$/u;

export class MemoryHubAccessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MemoryHubAccessError';
  }
}

function panelBaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new MemoryHubAccessError('invalid_panel_url', 'Memory Hub panelUrl must be a valid HTTP(S) URL');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new MemoryHubAccessError(
      'invalid_panel_url',
      'Memory Hub panelUrl must be an HTTP(S) URL without credentials, query strings, or fragments',
    );
  }
  return parsed;
}

/**
 * Build an authenticated Memory Hub URL without copying the Hub credential into
 * bots.json. The admin user_key remains in the runtime's mode-0600 file and is
 * read only when an authenticated dashboard write action asks to open the Hub.
 *
 * The credential is placed in the URL fragment so it is never sent in the HTTP
 * request line, reverse-proxy logs, or Referer headers. The patched Hub consumes
 * it once, stores its normal local session, and removes it from the address bar.
 */
export function buildMemoryHubLoginUrl(config: ResolvedTopicGroupMemoryTencentDbConfig): string {
  if (!config.panelUrl) {
    throw new MemoryHubAccessError('panel_url_missing', 'Memory Hub panelUrl is not configured');
  }
  const panel = panelBaseUrl(config.panelUrl);
  const runtimeDir = resolveTencentDbRuntimeDir(config);
  const keyPath = join(runtimeDir, '.runtime', 'hub', 'admin-user-key');
  let userKey: string | null;
  try {
    userKey = readSecureHostFileSync(keyPath, 256)?.trim() || null;
  } catch (error) {
    throw new MemoryHubAccessError(
      'hub_user_key_unreadable',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!userKey) {
    throw new MemoryHubAccessError('hub_user_key_missing', 'Memory Hub admin user_key is not initialized');
  }
  if (!USER_KEY_PATTERN.test(userKey)) {
    throw new MemoryHubAccessError('hub_user_key_invalid', 'Memory Hub admin user_key has an invalid format');
  }
  const params = new URLSearchParams({
    user_key: userKey,
    instance_id: config.serviceId,
  });
  panel.hash = `#/memory?${params.toString()}`;
  return panel.toString();
}
