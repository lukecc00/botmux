import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectGlobalInstallManager,
  formatGlobalInstallCommand,
  resolveGlobalInstallPlan,
  tryResolveGlobalInstallPlan,
  UnsupportedGlobalInstallError,
} from '../src/utils/global-install.js';

describe('resolveGlobalInstallPlan', () => {
  it('updates an installer-managed source release from the pinned personal repo and prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-managed-source-'));
    try {
      writeFileSync(join(root, '.botmux-install.json'), JSON.stringify({
        schemaVersion: 1, method: 'github-source', repo: 'lukecc00/botmux', ref: 'p/ai_open',
        revision: 'b'.repeat(40), version: '3.1.0', prefix: '/opt/personal botmux',
        installedAt: '2026-07-19T00:00:00.000Z',
      }));
      expect(resolveGlobalInstallPlan(root, 'linux')).toEqual({
        manager: 'github-source', command: 'sh', args: ['/opt/personal botmux/share/botmux/current/install.sh'],
        env: {
          BOTMUX_INSTALL_PREFIX: '/opt/personal botmux',
          BOTMUX_INSTALL_REPO: 'lukecc00/botmux',
          BOTMUX_INSTALL_REF: 'p/ai_open',
        },
        activePackageRoot: '/opt/personal botmux/share/botmux/current',
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not trust source metadata that points at another repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-managed-source-bad-'));
    try {
      writeFileSync(join(root, '.botmux-install.json'), JSON.stringify({
        schemaVersion: 1, method: 'github-source', repo: 'deepcoldy/botmux', ref: 'master',
        revision: 'b'.repeat(40), version: '3.1.0', prefix: '/opt/botmux', installedAt: 'x',
      }));
      expect(() => resolveGlobalInstallPlan(root, 'linux')).toThrow(UnsupportedGlobalInstallError);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('targets the exact POSIX npm prefix', () => {
    const plan = resolveGlobalInstallPlan('/home/bot/.local/lib/node_modules/botmux', 'linux');
    expect(plan).toEqual({
      manager: 'npm',
      command: 'npm',
      args: ['install', '-g', '--prefix', '/home/bot/.local', 'botmux@latest'],
      activePackageRoot: '/home/bot/.local/lib/node_modules/botmux',
    });
  });

  it('targets the exact Windows npm prefix', () => {
    const plan = resolveGlobalInstallPlan(String.raw`D:\tools\npm-global\node_modules\botmux`, 'win32');
    expect(plan.args).toEqual([
      'install', '-g', '--prefix', String.raw`D:\tools\npm-global`, 'botmux@latest',
    ]);
    expect(plan.activePackageRoot).toBe(String.raw`D:\tools\npm-global\node_modules\botmux`);
  });

  it('targets pnpm global-dir and returns the stable package symlink for a runtime realpath', () => {
    const plan = resolveGlobalInstallPlan(
      '/home/bot/.local/share/pnpm/global/5/.pnpm/botmux@3.2.1/node_modules/botmux',
      'linux',
    );
    expect(plan).toEqual({
      manager: 'pnpm',
      command: 'pnpm',
      args: ['add', '-g', '--global-dir', '/home/bot/.local/share/pnpm/global', 'botmux@latest'],
      activePackageRoot: '/home/bot/.local/share/pnpm/global/5/node_modules/botmux',
    });
  });

  it('recognises the real pnpm global virtual-store path shape', () => {
    expect(detectGlobalInstallManager(
      '/home/bot/.local/share/pnpm/global/5/.pnpm/botmux@3.2.1/node_modules/botmux',
      'linux',
    )).toBe('pnpm');
  });

  it('recognises a preserved standard pnpm global symlink', () => {
    const root = '/home/bot/.local/share/pnpm/global/5/node_modules/botmux';
    const plan = resolveGlobalInstallPlan(root, 'linux');
    expect(plan.manager).toBe('pnpm');
    expect(plan.activePackageRoot).toBe(root);
  });

  it('handles a Windows pnpm virtual-store path', () => {
    const plan = resolveGlobalInstallPlan(
      String.raw`D:\pnpm\global\5\.pnpm\botmux@3.2.1\node_modules\botmux`,
      'win32',
    );
    expect(plan.manager).toBe('pnpm');
    expect(plan.args).toEqual([
      'add', '-g', '--global-dir', 'D:/pnpm/global', 'botmux@latest',
    ]);
    expect(plan.activePackageRoot).toBe(String.raw`D:\pnpm\global\5\node_modules\botmux`);
  });

  it('pins Bun updates to the owning POSIX global package and bin directories', () => {
    const root = '/home/bot/.bun/install/global/node_modules/botmux';
    const plan = resolveGlobalInstallPlan(root, 'linux');
    expect(plan).toEqual({
      manager: 'bun',
      command: 'bun',
      args: ['add', '-g', 'botmux@latest'],
      env: {
        BUN_INSTALL_GLOBAL_DIR: '/home/bot/.bun/install/global',
        BUN_INSTALL_BIN: '/home/bot/.bun/bin',
      },
      activePackageRoot: root,
    });
  });

  it('pins Bun updates to the owning Windows global package and bin directories', () => {
    const root = String.raw`D:\Users\bot\.bun\install\global\node_modules\botmux`;
    const plan = resolveGlobalInstallPlan(root, 'win32');
    expect(plan.manager).toBe('bun');
    expect(plan.args).toEqual(['add', '-g', 'botmux@latest']);
    expect(plan.env).toEqual({
      BUN_INSTALL_GLOBAL_DIR: String.raw`D:\Users\bot\.bun\install\global`,
      BUN_INSTALL_BIN: String.raw`D:\Users\bot\.bun\bin`,
    });
    expect(plan.activePackageRoot).toBe(root);
  });

  it.each([
    ['/home/bot/.config/yarn/global/node_modules/botmux', 'yarn'],
    ['/opt/custom/node_modules/botmux', 'unknown'],
    ['/work/botmux', 'unknown'],
  ] as const)('rejects unsupported ownership for %s', (root, manager) => {
    expect(detectGlobalInstallManager(root, 'linux')).toBe(manager);
    expect(() => resolveGlobalInstallPlan(root, 'linux')).toThrow(UnsupportedGlobalInstallError);
    expect(tryResolveGlobalInstallPlan(root, 'linux')).toBeNull();
  });

  it('formats paths with spaces for display', () => {
    const plan = resolveGlobalInstallPlan('/home/bot/My Prefix/lib/node_modules/botmux', 'linux');
    expect(formatGlobalInstallCommand(plan)).toBe(
      'npm install -g --prefix "/home/bot/My Prefix" botmux@latest',
    );
  });
});
