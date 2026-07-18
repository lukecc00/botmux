/**
 * Distinguishes a local source checkout (or git worktree) from a published
 * npm install. Used to disable auto-update for local-dev deployments — running
 * a global package update against a daemon that runs from a git checkout
 * would not take effect and only risks confusion.
 *
 * npm publishes only `dist/` (+ a few root files; see package.json `files`),
 * never `.git` or `src/`, so the presence of either at the package root is a
 * reliable "running from source" signal.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERSONAL_UPDATE_REPO = 'lukecc00/botmux';
export const PERSONAL_UPDATE_REF = 'p/ai_open';
export const MANAGED_SOURCE_INSTALL_FILE = '.botmux-install.json';

export interface ManagedSourceInstallInfo {
  schemaVersion: 1;
  method: 'github-source';
  repo: typeof PERSONAL_UPDATE_REPO;
  ref: typeof PERSONAL_UPDATE_REF;
  revision: string;
  version: string;
  prefix: string;
  installedAt: string;
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

/** Exact repo/ref validation is a supply-chain boundary: this personal build
 * must never silently update from the official npm package or another fork. */
export function managedSourceInstallAt(rootDir: string): ManagedSourceInstallInfo | null {
  try {
    const value = JSON.parse(readFileSync(join(rootDir, MANAGED_SOURCE_INSTALL_FILE), 'utf-8')) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || value.method !== 'github-source'
      || value.repo !== PERSONAL_UPDATE_REPO || value.ref !== PERSONAL_UPDATE_REF
      || typeof value.revision !== 'string' || !/^[0-9a-f]{40}$/i.test(value.revision)
      || !validVersion(value.version) || typeof value.prefix !== 'string' || !isAbsolute(value.prefix)
      || typeof value.installedAt !== 'string') return null;
    return value as unknown as ManagedSourceInstallInfo;
  } catch {
    return null;
  }
}

export function managedSourceInstall(): ManagedSourceInstallInfo | null {
  return managedSourceInstallAt(packageRoot());
}

/** Pure check: is `rootDir` a source checkout rather than a managed source
 * release or npm install? */
export function isLocalDevInstallAt(rootDir: string): boolean {
  if (existsSync(join(rootDir, '.git'))) return true;
  if (managedSourceInstallAt(rootDir)) return false;
  return existsSync(join(rootDir, 'src'));
}

let cached: boolean | undefined;

/** Classify this running install. Cached — it cannot change at runtime. */
export function isLocalDevInstall(): boolean {
  if (cached === undefined) cached = isLocalDevInstallAt(packageRoot());
  return cached;
}

/** The running botmux version (from the install's package.json). For an
 *  npm-global install this is the real published version; in a source checkout
 *  it's the unbuilt '0.0.0' (CI injects the real version at publish). */
export function botmuxVersionAt(rootDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
    if (typeof pkg.version === 'string' && pkg.version !== '0.0.0') return pkg.version;
  } catch {
    // Fall through.
  }
  const managed = managedSourceInstallAt(rootDir);
  if (managed) return managed.version;
  try {
    const release = JSON.parse(readFileSync(join(rootDir, 'dev-version.json'), 'utf-8'));
    return validVersion(release?.version) ? release.version : '0.0.0';
  } catch { return '0.0.0'; }
}

export function botmuxVersion(): string {
  return botmuxVersionAt(packageRoot());
}

/** Absolute path to this install's CLI entrypoint (`dist/cli.js`). The correct
 *  way to restart is `node <this>/dist/cli.js restart` — a raw `pm2 restart`
 *  would not pick up a changed install dir. */
export function botmuxCliEntryAt(rootDir: string): string {
  return join(rootDir, 'dist', 'cli.js');
}

export function botmuxCliEntry(): string {
  return botmuxCliEntryAt(packageRoot());
}

/** Absolute path to this install's root (the dir holding package.json). For a
 *  source checkout this is the git working tree — used to derive a real version
 *  via `git describe` when package.json is the unbuilt 0.0.0. */
export function botmuxInstallRoot(): string {
  return packageRoot();
}

/** Walk up from this module to the nearest dir containing package.json. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}
