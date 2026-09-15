import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTopicGroupMemoryConfig } from '../src/services/topic-group-memory-config.js';
import { captureTencentDbTurnOnce } from '../src/services/tencentdb-agent-memory-ledger.js';
import { probeTopicGroupMemoryRuntimeStatus } from '../src/services/topic-group-memory-status.js';
import type { TopicGroupMemoryStats } from '../src/services/topic-group-memory-store.js';

const dirs: string[] = [];

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botmux-topic-memory-status-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function memory(chatId: string, updatedAt = '2026-09-01T00:00:00.000Z', revision = 3): TopicGroupMemoryStats {
  return {
    larkAppId: 'app_test',
    chatId,
    path: `/tmp/${chatId}.json`,
    exists: true,
    hasContent: true,
    revision,
    updatedAt,
    sizeBytes: 100,
    summaryChars: 20,
    facts: 1,
    decisions: 0,
    openQuestions: 0,
    resources: 0,
    recentContributions: 1,
  };
}

describe('topic-group memory runtime status', () => {
  it('auto mode requires the runtime manifest and a real scope-specific data-plane probe', async () => {
    const config = resolveTopicGroupMemoryConfig({ enabled: true, provider: 'auto' });
    const available = vi.fn(async () => true);

    const missingManifest = await probeTopicGroupMemoryRuntimeStatus(
      'app_test',
      config,
      [memory('chat-a')],
      { access: async () => { throw new Error('ENOENT'); }, memoryCoreAvailable: available },
    );
    expect(missingManifest).toMatchObject({
      runtimeManifestPresent: false,
      memoryCoreHealthy: null,
      effectiveProvider: 'local-fallback',
    });
    expect(available).not.toHaveBeenCalled();

    const healthy = await probeTopicGroupMemoryRuntimeStatus(
      'app_test',
      config,
      [memory('chat-a')],
      { access: async () => undefined, memoryCoreAvailable: available },
    );
    expect(available).toHaveBeenCalledWith({ larkAppId: 'app_test', chatId: 'chat-a', config });
    expect(healthy).toMatchObject({
      runtimeManifestPresent: true,
      probedChatId: 'chat-a',
      memoryCoreHealthy: true,
      effectiveProvider: 'tencentdb',
    });
  });

  it('forced TencentDB probes without a manifest and reports local fallback on failure', async () => {
    const config = resolveTopicGroupMemoryConfig({ enabled: true, provider: 'tencentdb' });
    const status = await probeTopicGroupMemoryRuntimeStatus(
      'app_test',
      config,
      [memory('chat-a')],
      {
        access: async () => { throw new Error('ENOENT'); },
        memoryCoreAvailable: async () => false,
      },
    );
    expect(status).toMatchObject({
      runtimeManifestPresent: false,
      memoryCoreHealthy: false,
      memoryCoreError: 'health_or_data_plane_probe_failed',
      effectiveProvider: 'local-fallback',
    });
  });

  it('does not invent an isolation scope when no topic-group memory exists', async () => {
    const config = resolveTopicGroupMemoryConfig({ enabled: true, provider: 'tencentdb' });
    const available = vi.fn(async () => true);
    const status = await probeTopicGroupMemoryRuntimeStatus(
      'app_test',
      config,
      [],
      { access: async () => undefined, memoryCoreAvailable: available },
    );
    expect(available).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      memoryCoreHealthy: null,
      effectiveProvider: 'not-checked',
      latestTencentDbCaptureAt: null,
      latestLocalUpdateAt: null,
    });
  });

  it('reports the latest TencentDB capture and local shadow revision', async () => {
    const dir = await dataDir();
    await captureTencentDbTurnOnce('app_test:chat-a', 'turn-old', async () => 'ok', {
      dataDir: dir,
      now: () => '2026-09-02T00:00:00.000Z',
    });
    await captureTencentDbTurnOnce('app_test:chat-b', 'turn-new', async () => 'ok', {
      dataDir: dir,
      now: () => '2026-09-03T00:00:00.000Z',
    });
    const config = resolveTopicGroupMemoryConfig({ enabled: true, provider: 'local' });
    const status = await probeTopicGroupMemoryRuntimeStatus(
      'app_test',
      config,
      [
        memory('chat-a', '2026-09-04T00:00:00.000Z', 9),
        memory('chat-b', '2026-09-01T00:00:00.000Z', 4),
      ],
      { dataDir: dir, access: async () => undefined },
    );
    expect(status).toMatchObject({
      effectiveProvider: 'local',
      latestTencentDbCaptureAt: '2026-09-03T00:00:00.000Z',
      latestTencentDbCaptureTurnId: 'turn-new',
      latestLocalUpdateAt: '2026-09-04T00:00:00.000Z',
      latestLocalRevision: 9,
    });
  });
});
