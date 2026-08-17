import { describe, expect, it, vi } from 'vitest';
import {
  applyTopicGroupMemoryUpdatePatch,
  distillTopicGroupMemoryPatchForFinal,
  type TopicGroupMemoryUpdatePatch,
} from '../src/services/topic-group-memory-update.js';
import { TopicGroupMemoryLlmError } from '../src/services/topic-group-memory-llm-distiller.js';
import { createEmptyTopicGroupMemory } from '../src/services/topic-group-memory-store.js';

function llmPatch() {
  return {
    schemaVersion: 1 as const,
    shouldUpdate: true,
    summaryPatch: '共享记忆按 chatId 聚合。',
    factsUpsert: ['同一话题群共享背景'],
    decisionsUpsert: ['默认关闭'],
    openQuestionsUpsert: ['何时启用 compact'],
    resourcesUpsert: [{ kind: 'prd' as const, title: '需求 PRD', url: 'https://bytedance.larkoffice.com/docx/PrdToken', description: '主需求文档' }],
    obsoleteItems: ['旧决策'],
    reason: '跨话题可复用。',
  };
}

describe('topic-group memory final update pipeline', () => {
  it('prefers a validated LLM patch over marker-only rules', async () => {
    const result = await distillTopicGroupMemoryPatchForFinal({
      oldMemory: null,
      userPrompt: '请确定共享方式',
      finalOutput: '最终已经确认采用 chatId 级共享记忆，并默认关闭。',
      cliContext: { cliId: 'codex' },
    }, {
      distillWithCli: vi.fn(async (_input, context) => {
        expect(context.cliId).toBe('codex');
        return llmPatch();
      }),
    });
    expect(result).toMatchObject({
      patch: {
        source: 'llm',
        summaryPatch: '共享记忆按 chatId 聚合。',
        factConfidence: 'inferred',
      },
    });
  });

  it('falls back to explicit marker rules after model failure', async () => {
    const result = await distillTopicGroupMemoryPatchForFinal({
      oldMemory: null,
      finalOutput: '已完成本阶段并通过测试。\n【共享记忆】\n事实：存储键包含 larkAppId + chatId\n决策：默认关闭',
      cliContext: { cliId: 'traex' },
    }, {
      distillWithCli: vi.fn(async () => { throw new TopicGroupMemoryLlmError('invalid_output'); }),
    });
    expect(result).toMatchObject({
      fallbackReason: 'traex:invalid_output',
      patch: {
        source: 'local',
        facts: ['存储键包含 larkAppId + chatId'],
        decisions: ['默认关闭'],
        factConfidence: 'confirmed',
      },
    });
  });

  it('uses loopback HTTP first and does not invoke a CLI after a valid HTTP decision', async () => {
    const distillWithCli = vi.fn(async () => llmPatch());
    const distillWithHttp = vi.fn(async () => llmPatch());
    const result = await distillTopicGroupMemoryPatchForFinal({
      oldMemory: null,
      userPrompt: '请确认共享方式',
      finalOutput: '最终已经确认采用 chatId 级共享记忆，并默认关闭。',
      cliContext: { cliId: 'claude-code' },
      httpContext: {
        baseUrl: 'http://127.0.0.1:8787/v1', model: 'memory-model', api: 'responses', timeoutMs: 1000,
      },
    }, { distillWithHttp, distillWithCli });
    expect(result?.provider).toBe('http');
    expect(distillWithHttp).toHaveBeenCalledTimes(1);
    expect(distillWithCli).not.toHaveBeenCalled();
  });

  it('falls through HTTP to the current agent CLI only', async () => {
    const attempts: string[] = [];
    const result = await distillTopicGroupMemoryPatchForFinal({
      oldMemory: null,
      userPrompt: '请确认共享方式',
      finalOutput: '最终已经确认采用 chatId 级共享记忆，并默认关闭。',
      cliContext: { cliId: 'claude-code', model: 'sonnet' },
      httpContext: {
        baseUrl: 'http://127.0.0.1:8787/v1', model: 'memory-model', api: 'responses', timeoutMs: 1000,
      },
    }, {
      distillWithHttp: vi.fn(async () => { attempts.push('http'); throw new TopicGroupMemoryLlmError('http_failed'); }),
      distillWithCli: vi.fn(async (_input, context) => {
        attempts.push(context.cliId);
        return llmPatch();
      }),
    });
    expect(attempts).toEqual(['http', 'claude-code']);
    expect(result?.provider).toBe('claude-code');
  });

  it('uses local deterministic distillation after HTTP and the current CLI fail', async () => {
    const attempts: string[] = [];
    const result = await distillTopicGroupMemoryPatchForFinal({
      oldMemory: null,
      finalOutput: '本轮已确认。\n【共享记忆】\n决策：HTTP 失败后只尝试当前 agent CLI。',
      cliContext: { cliId: 'traex' },
      httpContext: {
        baseUrl: 'http://127.0.0.1:8787/v1', model: 'memory-model', api: 'responses', timeoutMs: 1000,
      },
    }, {
      distillWithHttp: vi.fn(async () => { attempts.push('http'); throw new TopicGroupMemoryLlmError('http_failed'); }),
      distillWithCli: vi.fn(async (_input, context) => {
        attempts.push(context.cliId);
        throw new TopicGroupMemoryLlmError('process_failed');
      }),
    });
    expect(attempts).toEqual(['http', 'traex']);
    expect(result).toMatchObject({ patch: { source: 'local', decisions: ['HTTP 失败后只尝试当前 agent CLI'] } });
  });

  it('does not promote unstructured facts when the LLM says no update', async () => {
    const result = await distillTopicGroupMemoryPatchForFinal({
      oldMemory: null,
      finalOutput: '这里只是一次临时测试日志，不应该沉淀为共享记忆。',
      cliContext: { cliId: 'codex' },
    }, {
      distillWithCli: vi.fn(async () => ({
        ...llmPatch(),
        shouldUpdate: false,
        summaryPatch: '',
        factsUpsert: [],
        decisionsUpsert: [],
        openQuestionsUpsert: [],
        resourcesUpsert: [],
        obsoleteItems: [],
      })),
    });
    expect(result).toBeNull();
  });

  it('merges summary and structured items with host-owned source metadata', () => {
    const doc = createEmptyTopicGroupMemory('cli_app', 'oc_chat');
    doc.summary = '旧摘要';
    doc.decisions.push({ id: 'decision_old', text: '旧决策', createdAt: '2026-01-01T00:00:00.000Z' });
    const patch: TopicGroupMemoryUpdatePatch = {
      source: 'llm',
      contributionSummary: '共享记忆按 chatId 聚合。',
      summaryPatch: '共享记忆按 chatId 聚合。',
      facts: ['同一话题群共享背景'],
      decisions: ['默认关闭'],
      openQuestions: ['何时启用 compact'],
      resources: [{ kind: 'prd', title: '需求 PRD', url: 'https://bytedance.larkoffice.com/docx/PrdToken', description: '主需求文档' }],
      obsoleteItems: ['旧决策'],
      factConfidence: 'inferred',
    };
    const updated = applyTopicGroupMemoryUpdatePatch(doc, patch, {
      turnId: 'turn_1',
      sessionId: 'session_1',
      rootMessageId: 'om_root',
      chatName: 'Memory Hub 验收话题群',
      now: '2026-07-27T00:00:00.000Z',
      maxSummaryChars: 6_000,
    });
    expect(updated).not.toBe(false);
    if (updated === false) throw new Error('unexpected no-op');
    expect(updated.summary).toBe('旧摘要\n\n共享记忆按 chatId 聚合。');
    expect(updated.decisions.map(item => item.text)).toEqual(['默认关闭']);
    expect(updated.facts[0]).toMatchObject({
      confidence: 'inferred',
      sourceSessionId: 'session_1',
      sourceRootMessageId: 'om_root',
    });
    expect(updated.resources[0]).toMatchObject({ kind: 'prd', title: '需求 PRD', url: 'https://bytedance.larkoffice.com/docx/PrdToken' });
    expect(updated.recentContributions[0].turnId).toBe('turn_1');
    expect(updated.chatName).toBe('Memory Hub 验收话题群');
  });

  it('is a no-op for duplicate final turns', () => {
    const doc = createEmptyTopicGroupMemory('cli_app', 'oc_chat');
    doc.recentContributions.push({
      turnId: 'turn_1', sessionId: 'session_1', rootMessageId: 'om_root',
      summary: 'already stored', createdAt: '2026-07-27T00:00:00.000Z',
    });
    expect(applyTopicGroupMemoryUpdatePatch(doc, {
      source: 'local', contributionSummary: 'duplicate', summaryPatch: '',
      facts: [], decisions: [], openQuestions: [], obsoleteItems: [], factConfidence: 'confirmed',
      resources: [],
    }, {
      turnId: 'turn_1', sessionId: 'session_1', rootMessageId: 'om_root',
      now: '2026-07-27T00:00:01.000Z', maxSummaryChars: 6_000,
    })).toBe(false);
  });
});
