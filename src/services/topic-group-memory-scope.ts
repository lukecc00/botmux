import type { DaemonSession } from '../core/types.js';
import { getChatMode, type ChatMode } from '../im/lark/client.js';
import { getBotTopicGroupMemoryConfig, type ResolvedTopicGroupMemoryConfig } from './topic-group-memory-config.js';

export type TopicGroupMemoryScopeDisabledReason =
  | 'config_disabled'
  | 'inject_disabled'
  | 'update_disabled'
  | 'p2p'
  | 'not_thread_scope'
  | 'missing_root_message_id'
  | 'not_topic_group';

export type TopicGroupMemoryScopeResult =
  | {
      enabled: true;
      larkAppId: string;
      chatId: string;
      rootMessageId: string;
      key: string;
      config: ResolvedTopicGroupMemoryConfig;
    }
  | { enabled: false; reason: TopicGroupMemoryScopeDisabledReason; config: ResolvedTopicGroupMemoryConfig };

export interface TopicGroupMemoryScopeInput {
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  scope: 'thread' | 'chat';
  rootMessageId?: string;
}

export interface ResolveTopicGroupMemoryScopeOptions {
  purpose?: 'inject' | 'update' | 'manual';
  getMode?: (larkAppId: string, chatId: string) => Promise<ChatMode>;
  config?: ResolvedTopicGroupMemoryConfig;
}

export async function resolveTopicGroupMemoryScope(
  input: TopicGroupMemoryScopeInput,
  options: ResolveTopicGroupMemoryScopeOptions = {},
): Promise<TopicGroupMemoryScopeResult> {
  const config = options.config ?? getBotTopicGroupMemoryConfig(input.larkAppId);
  const purpose = options.purpose ?? 'inject';
  if (!config.enabled) return { enabled: false, reason: 'config_disabled', config };
  if (purpose === 'inject' && config.injectMode === 'off') return { enabled: false, reason: 'inject_disabled', config };
  if (purpose === 'update' && config.updateMode !== 'auto') return { enabled: false, reason: 'update_disabled', config };
  if (input.chatType === 'p2p') return { enabled: false, reason: 'p2p', config };
  if (input.scope !== 'thread') return { enabled: false, reason: 'not_thread_scope', config };
  const rootMessageId = input.rootMessageId?.trim();
  if (!rootMessageId || !rootMessageId.startsWith('om_')) {
    return { enabled: false, reason: 'missing_root_message_id', config };
  }
  const mode = await (options.getMode ?? getChatMode)(input.larkAppId, input.chatId);
  if (mode !== 'topic') return { enabled: false, reason: 'not_topic_group', config };
  return {
    enabled: true,
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    rootMessageId,
    key: `${input.larkAppId}:${input.chatId}`,
    config,
  };
}

export function topicGroupMemoryScopeInputFromSession(ds: DaemonSession): TopicGroupMemoryScopeInput {
  return {
    larkAppId: ds.larkAppId,
    chatId: ds.chatId,
    chatType: ds.chatType,
    scope: ds.scope,
    rootMessageId: ds.session.rootMessageId,
  };
}
