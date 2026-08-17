import { describe, expect, it, vi } from 'vitest';
import { resolveTopicGroupMemoryScope } from '../src/services/topic-group-memory-scope.js';
import {
  DEFAULT_TOPIC_GROUP_MEMORY_CONFIG,
  normalizeTopicGroupMemoryConfig,
  resolveTopicGroupMemoryConfig,
} from '../src/services/topic-group-memory-config.js';

const enabled = { ...DEFAULT_TOPIC_GROUP_MEMORY_CONFIG, enabled: true };
const base = { larkAppId: 'cli_app', chatId: 'oc_chat', chatType: 'group' as const, scope: 'thread' as const, rootMessageId: 'om_root' };

describe('topic-group memory scope', () => {
  it('enables only a real topic group thread', async () => {
    const getMode = vi.fn(async () => 'topic' as const);
    const result = await resolveTopicGroupMemoryScope(base, { config: enabled, getMode });
    expect(result.enabled).toBe(true);
    expect(getMode).toHaveBeenCalledWith('cli_app', 'oc_chat');
  });

  it.each([
    [{ ...base, chatType: 'p2p' as const }, 'p2p'],
    [{ ...base, scope: 'chat' as const }, 'not_thread_scope'],
    [{ ...base, rootMessageId: undefined }, 'missing_root_message_id'],
  ])('rejects %s', async (input, reason) => {
    const result = await resolveTopicGroupMemoryScope(input, { config: enabled, getMode: async () => 'topic' });
    expect(result).toMatchObject({ enabled: false, reason });
  });

  it('rejects a regular group thread', async () => {
    const result = await resolveTopicGroupMemoryScope(base, { config: enabled, getMode: async () => 'group' });
    expect(result).toMatchObject({ enabled: false, reason: 'not_topic_group' });
  });

  it('is disabled by default and does not call chat mode', async () => {
    const getMode = vi.fn(async () => 'topic' as const);
    const result = await resolveTopicGroupMemoryScope(base, { config: DEFAULT_TOPIC_GROUP_MEMORY_CONFIG, getMode });
    expect(result).toMatchObject({ enabled: false, reason: 'config_disabled' });
    expect(getMode).not.toHaveBeenCalled();
  });

  it('uses the documented 8k injection and 10k summary hard limits', () => {
    expect(DEFAULT_TOPIC_GROUP_MEMORY_CONFIG).toMatchObject({
      provider: 'auto',
      maxPromptChars: 8_000,
      maxSummaryChars: 10_000,
      tencentdb: {
        endpoint: 'http://127.0.0.1:8420',
        teamId: 'botmux-topic-{scopeHash}',
        agentId: 'botmux-{appHash}',
      },
    });
    expect(resolveTopicGroupMemoryConfig(normalizeTopicGroupMemoryConfig({
      provider: 'tencentdb',
      maxPromptChars: 99_000,
      maxSummaryChars: 99_000,
      tencentdb: { maxResults: 99, timeoutMs: 999_999 },
    }))).toMatchObject({
      provider: 'tencentdb',
      maxPromptChars: 8_000,
      maxSummaryChars: 10_000,
      tencentdb: { maxResults: 20, timeoutMs: 60_000 },
    });
  });
});
