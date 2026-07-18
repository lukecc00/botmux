import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isLocalDevInstallAt,
  isLocalDevInstall,
  botmuxVersion,
  botmuxVersionAt,
  botmuxCliEntryAt,
  managedSourceInstallAt,
} from '../src/utils/install-info.js';

function writeManaged(root: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(root, '.botmux-install.json'), JSON.stringify({
    schemaVersion: 1,
    method: 'github-source',
    repo: 'lukecc00/botmux',
    ref: 'p/ai_open',
    revision: 'a'.repeat(40),
    version: '3.1.0',
    prefix: '/home/bot/.local',
    installedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  }));
}

describe('isLocalDevInstallAt', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-install-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('true when a .git directory is present (checkout)', () => {
    mkdirSync(join(dir, '.git'));
    expect(isLocalDevInstallAt(dir)).toBe(true);
  });
  it('true when .git is a file (git worktree pointer)', () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(isLocalDevInstallAt(dir)).toBe(true);
  });
  it('true when a src/ directory is present (unpublished source tree)', () => {
    mkdirSync(join(dir, 'src'));
    expect(isLocalDevInstallAt(dir)).toBe(true);
  });
  it('false for an npm-global-style install (only dist/, no .git/src)', () => {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'botmux' }));
    expect(isLocalDevInstallAt(dir)).toBe(false);
  });
  it('false for an installer-managed source release even though src/ is present', () => {
    mkdirSync(join(dir, 'src'));
    writeManaged(dir);
    expect(isLocalDevInstallAt(dir)).toBe(false);
    expect(managedSourceInstallAt(dir)).toMatchObject({ repo: 'lukecc00/botmux', ref: 'p/ai_open' });
  });
  it('fails closed on another repository or malformed revision', () => {
    mkdirSync(join(dir, 'src'));
    writeManaged(dir, { repo: 'deepcoldy/botmux' });
    expect(managedSourceInstallAt(dir)).toBeNull();
    expect(isLocalDevInstallAt(dir)).toBe(true);
    writeManaged(dir, { revision: 'short' });
    expect(managedSourceInstallAt(dir)).toBeNull();
  });
});

describe('isLocalDevInstall (runtime)', () => {
  it('returns a boolean and detects this checkout/worktree as local-dev', () => {
    const v = isLocalDevInstall();
    expect(typeof v).toBe('boolean');
    expect(v).toBe(true); // the test runs from a git working copy with src/
  });
});

describe('botmuxVersion', () => {
  it('reads the version from the package root package.json', () => {
    // resolve repo root from this test file: test/ → repo root
    const root = fileURLToPath(new URL('..', import.meta.url));
    const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
    const expected = packageVersion === '0.0.0'
      ? JSON.parse(readFileSync(join(root, 'dev-version.json'), 'utf-8')).version
      : packageVersion;
    expect(botmuxVersion()).toBe(expected);
  });

  it('can read a stable package root selected by the updater', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-version-at-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.8.7' }));
      expect(botmuxVersionAt(root)).toBe('9.8.7');
      expect(botmuxCliEntryAt(root)).toBe(join(root, 'dist', 'cli.js'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('reads the personal source release version when package.json is the source placeholder', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-source-version-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.0.0' }));
      writeManaged(root, { version: '3.1.0' });
      expect(botmuxVersionAt(root)).toBe('3.1.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
