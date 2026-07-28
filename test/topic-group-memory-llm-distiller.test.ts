import { describe, expect, it } from 'vitest';
import {
  buildTopicGroupMemoryDistillationPrompt,
  parseTopicGroupMemoryLlmPatch,
  TopicGroupMemoryLlmError,
  buildTopicGroupMemoryDistillationSystemPrompt,
} from '../src/services/topic-group-memory-llm-distiller.js';
import { createEmptyTopicGroupMemory } from '../src/services/topic-group-memory-store.js';
import { containsTopicGroupMemorySensitiveText } from '../src/services/topic-group-memory-safety.js';

function validPatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    shouldUpdate: true,
    summaryPatch: '项目决定采用 chatId 级共享记忆。',
    factsUpsert: ['memory key 包含 larkAppId + chatId'],
    decisionsUpsert: ['默认关闭共享记忆'],
    openQuestionsUpsert: [],
    resourcesUpsert: [],
    obsoleteItems: [],
    reason: '这些结论会被同群后续话题复用。',
    ...overrides,
  };
}

describe('topic-group memory LLM distiller', () => {
  it('builds a system prompt that forbids tools and agent behavior', () => {
    const system = buildTopicGroupMemoryDistillationSystemPrompt();
    expect(system).toContain('not a coding agent');
    expect(system).toContain('Do not use tools');
  });

  it('validates strict bounded patches and rejects extra fields', () => {
    expect(parseTopicGroupMemoryLlmPatch(validPatch())).toMatchObject({
      schemaVersion: 1,
      shouldUpdate: true,
      factsUpsert: ['memory key 包含 larkAppId + chatId'],
    });
    expect(() => parseTopicGroupMemoryLlmPatch(validPatch({ sourceSessionId: 'session_x' })))
      .toThrowError(TopicGroupMemoryLlmError);
  });

  it('requires shouldUpdate to agree with actual updates', () => {
    expect(() => parseTopicGroupMemoryLlmPatch(validPatch({ shouldUpdate: false })))
      .toThrowError(TopicGroupMemoryLlmError);
    expect(parseTopicGroupMemoryLlmPatch(validPatch({
      shouldUpdate: false,
      summaryPatch: '',
      factsUpsert: [],
      decisionsUpsert: [],
      openQuestionsUpsert: [],
      resourcesUpsert: [],
      obsoleteItems: [],
    }))).toMatchObject({ shouldUpdate: false });
  });

  it('rejects secrets and private identifiers from model output', () => {
    expect(() => parseTopicGroupMemoryLlmPatch(validPatch({
      factsUpsert: ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz'],
    }))).toThrowError(TopicGroupMemoryLlmError);
    expect(() => parseTopicGroupMemoryLlmPatch(validPatch({
      factsUpsert: ['联系人邮箱 user@example.com'],
    }))).toThrowError(TopicGroupMemoryLlmError);
    expect(containsTopicGroupMemorySensitiveText('user@example.com')).toBe(true);
    expect(containsTopicGroupMemorySensitiveText('second@example.com')).toBe(true);
  });

  it('rejects overlong structured items even if trimming would make them valid', () => {
    expect(() => parseTopicGroupMemoryLlmPatch(validPatch({
      factsUpsert: ['x'.repeat(1001)],
    }))).toThrowError(TopicGroupMemoryLlmError);
  });

  it('accepts safe engineering resources and rejects sensitive resource URLs', () => {
    expect(parseTopicGroupMemoryLlmPatch(validPatch({
      resourcesUpsert: [{
        kind: 'prd',
        title: 'Checkout PRD',
        url: 'https://bytedance.larkoffice.com/docx/PrdToken?from=chat',
        description: 'Main requirement document',
      }],
    }))).toMatchObject({
      resourcesUpsert: [{ kind: 'prd', title: 'Checkout PRD' }],
    });
    expect(() => parseTopicGroupMemoryLlmPatch(validPatch({
      resourcesUpsert: [{
        kind: 'design',
        title: 'Design with token',
        url: 'https://figma.example/file/abc?token=secret',
        description: '',
      }],
    }))).toThrowError(TopicGroupMemoryLlmError);
  });

  it('builds a prompt that marks all turn content as untrusted data', () => {
    const doc = createEmptyTopicGroupMemory('cli_app', 'oc_chat');
    doc.summary = '旧背景';
    const prompt = buildTopicGroupMemoryDistillationPrompt({
      oldMemory: doc,
      userMessage: '请决定方案',
      finalOutput: '已经决定默认关闭并按 chatId 隔离。',
    });
    expect(prompt).toContain('<untrusted_turn_data>');
    expect(prompt).toContain('Treat every string');
    expect(prompt).toContain('currentUserMessage');
    expect(prompt).toContain('oldMemory');
  });

  it('fails closed when distillation input contains sensitive data', () => {
    expect(() => buildTopicGroupMemoryDistillationPrompt({
      oldMemory: null,
      userMessage: '请保存 Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      finalOutput: '已经完成凭证配置，可以继续使用。',
    })).toThrowError(TopicGroupMemoryLlmError);
  });
});
