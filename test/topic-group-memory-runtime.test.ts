import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTopicGroupMemoryConfig } from '../src/services/topic-group-memory-config.js';

const state = vi.hoisted(() => ({
  config: undefined as any,
  shouldAttempt: false,
  available: false,
  localReads: 0,
  availabilityChecks: 0,
  recalls: 0,
}));

vi.mock('../src/services/topic-group-memory-scope.js', () => ({
  resolveTopicGroupMemoryScope: async (input: any) => ({
    enabled: true,
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    rootMessageId: input.rootMessageId,
    key: `${input.larkAppId}:${input.chatId}`,
    config: state.config,
  }),
  topicGroupMemoryScopeInputFromSession: vi.fn(),
}));

vi.mock('../src/services/topic-group-memory-store.js', () => ({
  readTopicGroupMemory: async () => {
    state.localReads += 1;
    return { revision: 1, summary: 'legacy memory' };
  },
  topicGroupMemoryHasContent: () => true,
}));

vi.mock('../src/services/topic-group-memory-renderer.js', () => ({
  renderTopicGroupMemoryBlock: () => '<topic_group_memory provider="local">legacy</topic_group_memory>',
}));

vi.mock('../src/services/tencentdb-agent-memory-client.js', () => ({
  shouldAttemptTencentDbMemory: () => state.shouldAttempt,
  tencentDbClientForConfig: () => ({
    recall: async () => {
      state.recalls += 1;
      return { memories: [{ id: 'm1', type: 'fact', content: 'shared' }], scenes: [], partialFailures: [] };
    },
  }),
  resolveTencentDbMemoryIsolation: () => ({ teamId: 'team', agentId: 'agent', userId: 'user' }),
  tencentDbMemoryAvailable: async () => {
    state.availabilityChecks += 1;
    return state.available;
  },
  renderTencentDbMemoryBlock: () => '<topic_group_memory provider="tencentdb-agent-memory">shared</topic_group_memory>',
}));

import { loadTopicGroupMemoryBlock } from '../src/services/topic-group-memory-runtime.js';

const input = {
  larkAppId: 'cli_app',
  chatId: 'oc_chat',
  chatType: 'group' as const,
  scope: 'thread' as const,
  rootMessageId: 'om_root',
};

describe('topic-group memory provider fallback', () => {
  beforeEach(() => {
    state.config = resolveTopicGroupMemoryConfig({ enabled: true, provider: 'auto' });
    state.shouldAttempt = false;
    state.available = false;
    state.localReads = 0;
    state.availabilityChecks = 0;
    state.recalls = 0;
  });

  it('uses the legacy provider without probing when the managed Runtime is absent', async () => {
    await expect(loadTopicGroupMemoryBlock(input, 'current question')).resolves.toContain('provider="local"');
    expect(state.availabilityChecks).toBe(0);
    expect(state.localReads).toBe(1);
  });

  it('falls back to the legacy hot shadow when the Runtime is present but unusable', async () => {
    state.shouldAttempt = true;
    await expect(loadTopicGroupMemoryBlock(input, 'current question')).resolves.toContain('provider="local"');
    expect(state.availabilityChecks).toBe(1);
    expect(state.localReads).toBe(1);
    expect(state.recalls).toBe(0);
  });

  it('prefers MemoryCore and skips the local read when authenticated recall is available', async () => {
    state.shouldAttempt = true;
    state.available = true;
    await expect(loadTopicGroupMemoryBlock(input, 'current question')).resolves.toContain('provider="tencentdb-agent-memory"');
    expect(state.recalls).toBe(1);
    expect(state.localReads).toBe(0);
  });
});
