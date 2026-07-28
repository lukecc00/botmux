import { describe, expect, it } from 'vitest';
import {
  compactTopicGroupMemoryLocalDoc,
  distillTopicGroupMemoryLocal,
  topicGroupMemorySemanticSimilarity,
} from '../src/services/topic-group-memory-local-compactor.js';
import { createEmptyTopicGroupMemory } from '../src/services/topic-group-memory-store.js';

describe('topic-group memory deterministic local compactor', () => {
  it('extracts durable decisions and facts from ordinary Chinese prose without markers', () => {
    const patch = distillTopicGroupMemoryLocal({
      oldMemory: null,
      userMessage: '本地 HTTP 失败以后只使用当前会话正在使用的 agent CLI，不要轮询其他 CLI。',
      finalOutput: `已经按要求调整。话题群共享记忆更新链路改为本地 HTTP LLM 优先，失败后只尝试当前会话 agent CLI；当前 CLI 仍失败时使用本地确定性压缩。不同话题群和不同 bot 之间不共享记忆。\n\n测试 139/139 通过，构建成功。`,
    });
    expect(patch).not.toBeNull();
    expect(patch?.decisions.join('\n')).toMatch(/本地 HTTP LLM 优先/);
    expect(patch?.decisions.join('\n')).toMatch(/当前会话 agent CLI/);
    expect(patch?.facts.join('\n')).toMatch(/不同话题群和不同 bot 之间不共享记忆/);
    expect(patch?.summaryReplacement).toMatch(/决策与约束/);
    expect(patch?.summaryReplacement).not.toMatch(/139\/139|构建成功/);
  });

  it('filters progress chatter, commands, test counts and deployment status', () => {
    const patch = distillTopicGroupMemoryLocal({
      oldMemory: null,
      userMessage: '帮我检查一下。',
      finalOutput: `收到，我先检查代码。\npnpm vitest run test/foo.test.ts\n测试 45/45 通过。\n部署完成，daemon 已重启。`,
    });
    expect(patch).toBeNull();
  });

  it('keeps concise durable decisions and treats uncertainty as unresolved rather than fact', () => {
    const concise = distillTopicGroupMemoryLocal({ oldMemory: null, finalOutput: '共享记忆默认关闭。' });
    expect(concise?.decisions).toEqual(['共享记忆默认关闭']);
    const uncertain = distillTopicGroupMemoryLocal({
      oldMemory: null,
      finalOutput: '可能需要默认关闭共享记忆，但目前无法确认。',
    });
    expect(uncertain?.decisions).toEqual([]);
    expect(uncertain?.openQuestions).toEqual(['可能需要默认关闭共享记忆，但目前无法确认']);
  });

  it('does not merge adjacent fallback stages that share CLI vocabulary', () => {
    expect(topicGroupMemorySemanticSimilarity(
      'HTTP 失败后只尝试当前会话 agent CLI。',
      '当前 agent CLI 失败后使用本地确定性压缩。',
    )).toBeLessThan(0.6);
  });

  it('preserves unresolved questions but does not store the user request itself as one', () => {
    const patch = distillTopicGroupMemoryLocal({
      oldMemory: null,
      userMessage: '你能不能修一下这个问题？',
      finalOutput: '共享记忆按 bot 和 chat 隔离。仍待确认是否允许跨 bot 联邦记忆。',
    });
    expect(patch?.openQuestions).toEqual(['仍待确认是否允许跨 bot 联邦记忆']);
    expect(patch?.openQuestions.join(' ')).not.toContain('修一下');
  });

  it('removes superseded old decisions and rebuilds the summary', () => {
    const memory = createEmptyTopicGroupMemory('cli_app', 'oc_chat');
    memory.summary = '旧策略使用固定顺序轮询所有 CLI。';
    memory.decisions.push({
      id: 'decision_old',
      text: 'HTTP 失败后按 Codex、TraeX、Claude 顺序轮询。',
      createdAt: memory.updatedAt,
    });
    const patch = distillTopicGroupMemoryLocal({
      oldMemory: memory,
      userMessage: '不要轮询其他 CLI。',
      finalOutput: '更新链路改为 HTTP 失败后只尝试当前会话 agent CLI，不再轮询其他 CLI。',
    });
    expect(patch?.obsoleteItems).toContain('HTTP 失败后按 Codex、TraeX、Claude 顺序轮询。');
    expect(patch?.summaryReplacement).toContain('只尝试当前会话 agent CLI');
    expect(patch?.summaryReplacement).not.toContain('Codex、TraeX、Claude 顺序轮询');
  });

  it('semantically deduplicates paraphrases with Chinese n-grams and English terms', () => {
    expect(topicGroupMemorySemanticSimilarity(
      '本地 HTTP 失败后仅使用当前会话 agent CLI。',
      'HTTP 调用失败以后只尝试当前 session 的 agent CLI。',
    )).toBeGreaterThan(0.3);
    const patch = distillTopicGroupMemoryLocal({
      oldMemory: null,
      finalOutput: `决定：本地 HTTP 失败后仅使用当前会话 agent CLI。\n最终策略是 HTTP 调用失败以后只尝试当前 session 的 agent CLI。`,
    });
    expect(patch?.decisions).toHaveLength(1);
  });

  it('keeps explicit markers as high-confidence input and extracts safe resources', () => {
    const patch = distillTopicGroupMemoryLocal({
      oldMemory: null,
      finalOutput: `【共享记忆】\n决策：默认关闭跨 bot 共享。\nPRD：https://example.com/prd`,
    });
    expect(patch?.factConfidence).toBe('confirmed');
    expect(patch?.decisions).toEqual(['默认关闭跨 bot 共享']);
    expect(patch?.resources).toMatchObject([{ kind: 'prd', url: 'https://example.com/prd' }]);
  });

  it('semantically compacts existing entries and rebuilds a concise summary', () => {
    const memory = createEmptyTopicGroupMemory('cli_app', 'oc_chat');
    memory.decisions.push(
      { id: 'old', text: '本地 HTTP 失败后仅使用当前会话 agent CLI。', createdAt: memory.updatedAt },
      { id: 'new', text: 'HTTP 调用失败以后只尝试当前 session 的 agent CLI。', createdAt: memory.updatedAt },
    );
    memory.facts.push({
      id: 'fact', text: '不同 bot 之间不共享话题群记忆。', createdAt: memory.updatedAt,
      updatedAt: memory.updatedAt, confidence: 'confirmed',
    });
    const compacted = compactTopicGroupMemoryLocalDoc(memory);
    expect(compacted.decisions).toHaveLength(1);
    expect(compacted.decisions[0].id).toBe('new');
    expect(compacted.summary).toContain('决策与约束');
    expect(compacted.summary).toContain('稳定背景');
  });
});
