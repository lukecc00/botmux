import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedTopicGroupMemoryConfig } from './topic-group-memory-config.js';
import type { TopicGroupMemoryStats } from './topic-group-memory-store.js';
import {
  resolveTencentDbMemoryIsolation,
  resolveTencentDbRuntimeDir,
  tencentDbClientForConfig,
} from './tencentdb-agent-memory-client.js';
import { latestTencentDbCaptureForScopes } from './tencentdb-agent-memory-ledger.js';

export type TopicGroupMemoryEffectiveProvider =
  | 'disabled'
  | 'local'
  | 'tencentdb'
  | 'local-fallback'
  | 'not-checked';

export interface TopicGroupMemoryRuntimeStatus {
  persisted: true;
  daemonEffectiveConfig: ResolvedTopicGroupMemoryConfig;
  effectiveProvider: TopicGroupMemoryEffectiveProvider;
  runtimeDir: string;
  runtimeManifestPresent: boolean;
  memoryCoreHealthy: boolean | null;
  memoryCoreError?: string;
  probedChatId?: string;
  hubConfigured: boolean;
  hubReachable: boolean | null;
  hubError?: string;
  latestTencentDbCaptureAt: string | null;
  latestTencentDbCaptureTurnId: string | null;
  latestLocalUpdateAt: string | null;
  latestLocalRevision: number | null;
}

export interface TopicGroupMemoryRuntimeStatusDeps {
  dataDir?: string;
  access?: (path: string) => Promise<void>;
  memoryCoreAvailable?: (input: {
    larkAppId: string;
    chatId: string;
    config: ResolvedTopicGroupMemoryConfig;
  }) => Promise<boolean>;
  fetch?: typeof fetch;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function probeTopicGroupMemoryRuntimeStatus(
  larkAppId: string,
  memoryConfig: ResolvedTopicGroupMemoryConfig,
  memories: readonly TopicGroupMemoryStats[],
  deps: TopicGroupMemoryRuntimeStatusDeps = {},
): Promise<TopicGroupMemoryRuntimeStatus> {
  const runtimeDir = resolveTencentDbRuntimeDir(memoryConfig.tencentdb);
  const manifestPath = join(runtimeDir, 'agent-integration.json');
  const access = deps.access ?? fsp.access;
  const runtimeManifestPresent = await access(manifestPath).then(() => true, () => false);
  const latestLocal = memories.find(memory => !!memory.updatedAt) ?? null;
  const latestCapture = await latestTencentDbCaptureForScopes(
    memories.map(memory => `${larkAppId}:${memory.chatId}`),
    { dataDir: deps.dataDir },
  ).catch(() => null);

  // A data-plane probe needs a real topic-group isolation key. Do not invent a
  // chat id merely to paint the dashboard green: with no known local scope the
  // honest state is "not checked", while the provider remains configured.
  const probeMemory = memories[0];
  const shouldProbeMemoryCore = memoryConfig.enabled
    && memoryConfig.provider !== 'local'
    && !!probeMemory
    && (memoryConfig.provider === 'tencentdb' || runtimeManifestPresent);
  let memoryCoreHealthy: boolean | null = null;
  let memoryCoreError: string | undefined;
  if (shouldProbeMemoryCore && probeMemory) {
    try {
      memoryCoreHealthy = await (deps.memoryCoreAvailable
        ? deps.memoryCoreAvailable({ larkAppId, chatId: probeMemory.chatId, config: memoryConfig })
        : (async () => {
            const client = tencentDbClientForConfig(memoryConfig);
            const isolation = resolveTencentDbMemoryIsolation(memoryConfig.tencentdb, {
              larkAppId,
              chatId: probeMemory.chatId,
            });
            if (!await client.health()) return false;
            await client.probe(isolation);
            return true;
          })());
      if (!memoryCoreHealthy) memoryCoreError = 'health_or_data_plane_probe_failed';
    } catch (error) {
      memoryCoreHealthy = false;
      memoryCoreError = errorText(error);
    }
  }

  let hubReachable: boolean | null = null;
  let hubError: string | undefined;
  if (memoryConfig.tencentdb.panelUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      try {
        const response = await (deps.fetch ?? fetch)(memoryConfig.tencentdb.panelUrl, {
          method: 'HEAD',
          redirect: 'manual',
          signal: controller.signal,
        });
        hubReachable = response.status > 0 && response.status < 500;
        if (!hubReachable) hubError = `http_${response.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      hubReachable = false;
      hubError = errorText(error);
    }
  }

  const effectiveProvider: TopicGroupMemoryEffectiveProvider = !memoryConfig.enabled
    ? 'disabled'
    : memoryConfig.provider === 'local'
      ? 'local'
      : memoryConfig.provider === 'auto' && !runtimeManifestPresent
        ? 'local-fallback'
      : memoryCoreHealthy === true
        ? 'tencentdb'
        : memoryCoreHealthy === false
          ? 'local-fallback'
          : 'not-checked';
  return {
    persisted: true,
    daemonEffectiveConfig: memoryConfig,
    effectiveProvider,
    runtimeDir,
    runtimeManifestPresent,
    memoryCoreHealthy,
    ...(memoryCoreError ? { memoryCoreError } : {}),
    ...(probeMemory ? { probedChatId: probeMemory.chatId } : {}),
    hubConfigured: !!memoryConfig.tencentdb.panelUrl,
    hubReachable,
    ...(hubError ? { hubError } : {}),
    latestTencentDbCaptureAt: latestCapture?.capturedAt ?? null,
    latestTencentDbCaptureTurnId: latestCapture?.turnId ?? null,
    latestLocalUpdateAt: latestLocal?.updatedAt ?? null,
    latestLocalRevision: latestLocal?.revision ?? null,
  };
}
