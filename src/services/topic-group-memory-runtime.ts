import type { DaemonSession } from '../core/types.js';
import { logger } from '../utils/logger.js';
import {
  renderTencentDbMemoryBlock,
  resolveTencentDbMemoryIsolation,
  shouldAttemptTencentDbMemory,
  tencentDbClientForConfig,
  tencentDbMemoryAvailable,
} from './tencentdb-agent-memory-client.js';
import { renderTopicGroupMemoryBlock } from './topic-group-memory-renderer.js';
import {
  resolveTopicGroupMemoryScope,
  topicGroupMemoryScopeInputFromSession,
  type TopicGroupMemoryScopeInput,
  type TopicGroupMemoryScopeResult,
} from './topic-group-memory-scope.js';
import { readTopicGroupMemory, topicGroupMemoryHasContent } from './topic-group-memory-store.js';

async function loadLocalMemoryBlock(scope: Extract<TopicGroupMemoryScopeResult, { enabled: true }>): Promise<string> {
  const doc = await readTopicGroupMemory(scope.larkAppId, scope.chatId);
  if (!doc) {
    logger.debug(`[topic-group-memory:${scope.key}] local injection skipped reason=memory_not_found`);
    return '';
  }
  if (!topicGroupMemoryHasContent(doc)) {
    logger.debug(`[topic-group-memory:${scope.key}] local injection skipped reason=memory_empty revision=${doc.revision}`);
    return '';
  }
  const block = renderTopicGroupMemoryBlock(doc, scope.config);
  if (block) {
    logger.info(`[topic-group-memory:${scope.key}] injected provider=local revision=${doc.revision} chars=${block.length}`);
  } else {
    logger.debug(`[topic-group-memory:${scope.key}] local injection skipped reason=render_empty revision=${doc.revision}`);
  }
  return block;
}

export async function loadTopicGroupMemoryBlock(
  input: TopicGroupMemoryScopeInput,
  query = '',
): Promise<string> {
  try {
    const scope = await resolveTopicGroupMemoryScope(input, { purpose: 'inject' });
    if (!scope.enabled) {
      logger.debug(`[topic-group-memory:${input.larkAppId}:${input.chatId}] injection skipped reason=${scope.reason}`);
      return '';
    }

    const recallQuery = query.trim();
    if (recallQuery && shouldAttemptTencentDbMemory(scope.config)) {
      try {
        const client = tencentDbClientForConfig(scope.config);
        const isolation = resolveTencentDbMemoryIsolation(scope.config.tencentdb, {
          larkAppId: scope.larkAppId,
          chatId: scope.chatId,
        });
        if (await tencentDbMemoryAvailable(client, isolation)) {
          const recall = await client.recall(isolation, recallQuery, scope.config.tencentdb);
          const block = renderTencentDbMemoryBlock({
            larkAppId: scope.larkAppId,
            chatId: scope.chatId,
            query: recallQuery,
            recall,
          }, scope.config);
          if (block) {
            logger.info(
              `[topic-group-memory:${scope.key}] injected provider=tencentdb chars=${block.length}`
              + (recall.partialFailures.length ? ` partial=${recall.partialFailures.join(',')}` : ''),
            );
            return block;
          }
          logger.debug(`[topic-group-memory:${scope.key}] tencentdb recall empty; falling back to local shadow`);
        } else {
          logger.debug(`[topic-group-memory:${scope.key}] tencentdb unavailable; falling back to local shadow`);
        }
      } catch (error) {
        logger.warn(
          `[topic-group-memory:${scope.key}] tencentdb recall failed; falling back to local shadow: `
          + (error instanceof Error ? error.message : String(error)),
        );
      }
    } else if (scope.config.provider !== 'local') {
      logger.debug(
        `[topic-group-memory:${scope.key}] tencentdb skipped reason=${recallQuery ? 'runtime_missing' : 'query_missing'}; falling back to local shadow`,
      );
    }

    return loadLocalMemoryBlock(scope);
  } catch (error) {
    logger.warn(`[topic-group-memory:${input.larkAppId}:${input.chatId}] injection skipped: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

export function loadTopicGroupMemoryBlockForSession(ds: DaemonSession, query?: string): Promise<string> {
  const effectiveQuery = query
    ?? ds.pendingPrompt
    ?? ds.lastUserPrompt
    ?? ds.session.lastUserPrompt
    ?? ds.lastCodexAppInput?.text
    ?? '';
  return loadTopicGroupMemoryBlock(topicGroupMemoryScopeInputFromSession(ds), effectiveQuery);
}
