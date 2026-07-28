import type { DaemonSession } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { renderTopicGroupMemoryBlock } from './topic-group-memory-renderer.js';
import {
  resolveTopicGroupMemoryScope,
  topicGroupMemoryScopeInputFromSession,
  type TopicGroupMemoryScopeInput,
} from './topic-group-memory-scope.js';
import { readTopicGroupMemory, topicGroupMemoryHasContent } from './topic-group-memory-store.js';

export async function loadTopicGroupMemoryBlock(
  input: TopicGroupMemoryScopeInput,
): Promise<string> {
  try {
    const scope = await resolveTopicGroupMemoryScope(input, { purpose: 'inject' });
    if (!scope.enabled) {
      logger.debug(`[topic-group-memory:${input.larkAppId}:${input.chatId}] injection skipped reason=${scope.reason}`);
      return '';
    }
    const doc = await readTopicGroupMemory(scope.larkAppId, scope.chatId);
    if (!doc) {
      logger.debug(`[topic-group-memory:${scope.key}] injection skipped reason=memory_not_found`);
      return '';
    }
    if (!topicGroupMemoryHasContent(doc)) {
      logger.debug(`[topic-group-memory:${scope.key}] injection skipped reason=memory_empty revision=${doc.revision}`);
      return '';
    }
    const block = renderTopicGroupMemoryBlock(doc, scope.config);
    if (block) {
      logger.info(`[topic-group-memory:${scope.key}] injected revision=${doc.revision} chars=${block.length}`);
    } else {
      logger.debug(`[topic-group-memory:${scope.key}] injection skipped reason=render_empty revision=${doc.revision}`);
    }
    return block;
  } catch (error) {
    logger.warn(`[topic-group-memory:${input.larkAppId}:${input.chatId}] injection skipped: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

export function loadTopicGroupMemoryBlockForSession(ds: DaemonSession): Promise<string> {
  return loadTopicGroupMemoryBlock(topicGroupMemoryScopeInputFromSession(ds));
}
