import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOTMUX_UPDATE_CHECK_INTERVAL_MS,
  botmuxUpdateStatePathIn,
  buildBotmuxUpdateCard,
  readBotmuxUpdateStateFrom,
  runBotmuxUpdateAudit,
  writeBotmuxUpdateStateTo,
  type BotmuxUpdateState,
} from '../src/core/botmux-update-monitor.js';
import type { ManagedSourceInstallInfo } from '../src/utils/install-info.js';

function managed(version: string): ManagedSourceInstallInfo {
  return {
    schemaVersion: 1,
    method: 'github-source',
    repo: 'lukecc00/botmux',
    ref: 'p/ai_open',
    revision: 'a'.repeat(40),
    version,
    prefix: '/opt/personal-botmux',
    installedAt: '2026-08-17T00:00:00.000Z',
  };
}

function state(overrides: Partial<BotmuxUpdateState> = {}): BotmuxUpdateState {
  return {
    schemaVersion: 1,
    repo: 'lukecc00/botmux',
    ref: 'p/ai_open',
    current: '3.2.8',
    latest: '3.2.9',
    updateAvailable: true,
    lastCheckedAt: 1_000,
    ...overrides,
  };
}

describe('runBotmuxUpdateAudit', () => {
  it('checks only installer-managed personal builds', async () => {
    const fetchLatest = vi.fn();
    const writeState = vi.fn();
    await runBotmuxUpdateAudit({
      now: () => 10_000,
      install: () => null,
      readState: () => null,
      writeState,
      fetchLatest,
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
  });

  it('honors the TTL and notifies once for each personal target version', async () => {
    let now = 1_000_000;
    let latest = '3.2.9';
    let persisted: BotmuxUpdateState | null = null;
    const fetchLatest = vi.fn(async () => latest);
    const notified: string[] = [];
    const deps = () => ({
      now: () => now,
      install: () => managed('3.2.8'),
      readState: () => persisted,
      writeState: (next: BotmuxUpdateState) => { persisted = structuredClone(next); },
      fetchLatest,
      notify: async (next: BotmuxUpdateState) => { notified.push(next.latest!); },
    });

    await runBotmuxUpdateAudit(deps());
    expect(notified).toEqual(['3.2.9']);
    expect(persisted).toMatchObject({
      current: '3.2.8',
      latest: '3.2.9',
      updateAvailable: true,
      lastNotifiedVersion: '3.2.9',
    });

    now += 60 * 60 * 1_000;
    await runBotmuxUpdateAudit(deps());
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    now += BOTMUX_UPDATE_CHECK_INTERVAL_MS;
    await runBotmuxUpdateAudit(deps());
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(notified).toEqual(['3.2.9']);

    latest = '3.3.0';
    now += BOTMUX_UPDATE_CHECK_INTERVAL_MS;
    await runBotmuxUpdateAudit(deps());
    expect(notified).toEqual(['3.2.9', '3.3.0']);
  });

  it('bypasses the TTL after an installed-version change', async () => {
    let persisted: BotmuxUpdateState | null = state({
      current: '3.2.8',
      latest: '3.2.9',
      lastCheckedAt: 9_999,
      lastNotifiedVersion: '3.2.9',
    });
    const fetchLatest = vi.fn(async () => '3.2.9');
    const notify = vi.fn();

    await runBotmuxUpdateAudit({
      now: () => 10_000,
      install: () => managed('3.2.9'),
      readState: () => persisted,
      writeState: next => { persisted = structuredClone(next); },
      fetchLatest,
      notify,
    });

    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(persisted).toMatchObject({
      current: '3.2.9',
      latest: '3.2.9',
      updateAvailable: false,
    });
  });

  it('does not consume the notification watermark when DM delivery fails', async () => {
    let persisted: BotmuxUpdateState | null = null;
    await runBotmuxUpdateAudit({
      now: () => 10_000,
      install: () => managed('3.2.8'),
      readState: () => persisted,
      writeState: next => { persisted = structuredClone(next); },
      fetchLatest: async () => '3.2.9',
      notify: async () => { throw new Error('Lark unavailable'); },
    });
    expect(persisted).toMatchObject({ latest: '3.2.9', updateAvailable: true });
    expect(persisted).not.toHaveProperty('lastNotifiedVersion');
  });

  it('retains last-known status when the manifest lookup is temporarily unavailable', async () => {
    let persisted: BotmuxUpdateState | null = state({ lastNotifiedVersion: '3.2.9' });
    await runBotmuxUpdateAudit({
      now: () => BOTMUX_UPDATE_CHECK_INTERVAL_MS + 2_000,
      install: () => managed('3.2.8'),
      readState: () => persisted,
      writeState: next => { persisted = structuredClone(next); },
      fetchLatest: async () => null,
    });
    expect(persisted).toMatchObject({
      current: '3.2.8',
      latest: '3.2.9',
      updateAvailable: true,
      lastNotifiedVersion: '3.2.9',
    });
  });
});

describe('Botmux update state and card', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-host-update-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('persists only the pinned personal channel and derives updateAvailable on read', () => {
    writeBotmuxUpdateStateTo(dir, state({ updateAvailable: false }));
    expect(botmuxUpdateStatePathIn(dir)).toBe(join(dir, 'botmux-updates.json'));
    expect(readBotmuxUpdateStateFrom(dir)).toMatchObject({
      repo: 'lukecc00/botmux',
      ref: 'p/ai_open',
      current: '3.2.8',
      latest: '3.2.9',
      updateAvailable: true,
    });

    const stored = JSON.parse(readFileSync(botmuxUpdateStatePathIn(dir), 'utf8'));
    expect(stored.schemaVersion).toBe(1);
  });

  it('rejects state copied from another repository or malformed version', () => {
    writeFileSync(botmuxUpdateStatePathIn(dir), JSON.stringify({
      ...state(),
      repo: 'deepcoldy/botmux',
    }));
    expect(readBotmuxUpdateStateFrom(dir)).toBeNull();

    writeFileSync(botmuxUpdateStatePathIn(dir), JSON.stringify({
      ...state(),
      current: 'v3.2.8',
    }));
    expect(readBotmuxUpdateStateFrom(dir)).toBeNull();
  });

  it('builds an owner-only personal-channel reminder with manual upgrade paths', () => {
    const card = buildBotmuxUpdateCard(state(), {
      dashboardUrl: 'http://dashboard',
      locale: 'zh',
    });
    expect(card).toContain('个人版 botmux 有新版本');
    expect(card).toContain('3.2.8');
    expect(card).toContain('3.2.9');
    expect(card).toContain('lukecc00/botmux@p/ai_open');
    expect(card).toContain('botmux upgrade && botmux restart');
    expect(card).toContain('不会自动安装');
    expect(card).toContain('http://dashboard');
    expect(card).not.toContain('button');
  });
});
