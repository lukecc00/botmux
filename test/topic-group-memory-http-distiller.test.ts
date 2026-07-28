import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTopicGroupMemoryCompactionPrompt,
  compactTopicGroupMemoryWithHttp,
  discoverCodexLoopbackHttpProvider,
  distillTopicGroupMemoryWithHttp,
  parseTopicGroupMemoryLlmCompactDoc,
  resolveTopicGroupMemoryHttpContext,
} from '../src/services/topic-group-memory-http-distiller.js';
import { createEmptyTopicGroupMemory } from '../src/services/topic-group-memory-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function configFile(text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'topic-memory-http-test-'));
  roots.push(root);
  const path = join(root, 'config.toml');
  writeFileSync(path, text);
  return path;
}

function patch() {
  return {
    schemaVersion: 1,
    shouldUpdate: true,
    summaryPatch: '共享记忆按群隔离。',
    factsUpsert: ['记忆键包含 bot 和 chat'],
    decisionsUpsert: [],
    openQuestionsUpsert: [],
    resourcesUpsert: [],
    obsoleteItems: [],
    reason: '后续话题可复用。',
  };
}

describe('topic-group memory loopback HTTP distiller', () => {
  it('discovers the active loopback Codex provider and rejects remote providers', () => {
    expect(discoverCodexLoopbackHttpProvider(configFile(`
model_provider = "proxy"
model = "gpt-local"
[model_providers.proxy]
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
`))).toEqual({ baseUrl: 'http://127.0.0.1:8787/v1', model: 'gpt-local', api: 'responses' });

    expect(discoverCodexLoopbackHttpProvider(configFile(`
model_provider = "remote"
model = "gpt-remote"
[model_providers.remote]
base_url = "https://api.example.com/v1"
wire_api = "responses"
`))).toBeNull();
  });

  it('uses Responses JSON schema and validates the returned patch', async () => {
    let request: RequestInit | undefined;
    const result = await distillTopicGroupMemoryWithHttp({
      oldMemory: null,
      userMessage: '请确认共享记忆方案',
      finalOutput: '已确认共享记忆按 bot 和 chat 隔离，后续话题可以复用。',
    }, {
      baseUrl: 'http://127.0.0.1:8787/v1', model: 'gpt-local', api: 'responses', timeoutMs: 1000,
    }, {
      fetch: vi.fn(async (_url, init) => {
        request = init;
        return new Response(JSON.stringify({ output_text: JSON.stringify(patch()) }), { status: 200 });
      }) as any,
    });
    expect(result.summaryPatch).toBe('共享记忆按群隔离。');
    const body = JSON.parse(String(request?.body));
    expect(body.text.format.type).toBe('json_schema');
    expect(body.input).toContain('<untrusted_turn_data>');
  });

  it('resolves only an explicitly configured loopback endpoint', () => {
    const context = resolveTopicGroupMemoryHttpContext({
      enabled: true,
      autoDiscoverCodex: false,
      baseUrl: 'http://localhost:9999/v1',
      model: 'memory-model',
      api: 'chat-completions',
      timeoutMs: 3000,
    });
    expect(context).toMatchObject({ baseUrl: 'http://localhost:9999/v1', model: 'memory-model', api: 'chat-completions' });
    expect(resolveTopicGroupMemoryHttpContext({
      enabled: true,
      autoDiscoverCodex: false,
      baseUrl: 'https://api.example.com/v1',
      model: 'remote-model',
      api: 'responses',
      timeoutMs: 3000,
    })).toBeNull();
    expect(resolveTopicGroupMemoryHttpContext({
      enabled: true,
      autoDiscoverCodex: false,
      baseUrl: 'http://0.0.0.0:9999/v1',
      model: 'wildcard-listener',
      api: 'responses',
      timeoutMs: 3000,
    })).toBeNull();
  });

  it('uses a full-document JSON schema for HTTP LLM maintenance compaction', async () => {
    const memory = createEmptyTopicGroupMemory('cli_a', 'oc_one');
    memory.summary = '重复的旧摘要';
    memory.facts.push({
      id: 'fact_1', text: '共享记忆按 bot 和 chat 隔离', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', confidence: 'confirmed',
    });
    let request: RequestInit | undefined;
    const result = await compactTopicGroupMemoryWithHttp(memory, {
      baseUrl: 'http://127.0.0.1:8787/v1', model: 'gpt-local', api: 'responses', timeoutMs: 1000,
    }, {
      fetch: vi.fn(async (_url, init) => {
        request = init;
        return new Response(JSON.stringify({ output_text: JSON.stringify({
          schemaVersion: 1,
          summary: '共享记忆按 bot 与 chat 隔离。',
          facts: ['共享记忆按 bot 与 chat 隔离'],
          decisions: [],
          openQuestions: [],
          resources: [],
          reason: '删除重复表述。',
        }) }), { status: 200 });
      }) as any,
    });
    expect(result.summary).toBe('共享记忆按 bot 与 chat 隔离。');
    const body = JSON.parse(String(request?.body));
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'topic_group_memory_compact', strict: true });
    expect(body.input).toContain('<untrusted_memory_document>');
    expect(buildTopicGroupMemoryCompactionPrompt(memory)).toContain('full replacement');
  });

  it('rejects malformed full-document compaction output', () => {
    expect(() => parseTopicGroupMemoryLlmCompactDoc({
      schemaVersion: 1,
      summary: 'summary',
      facts: ['fact'],
      decisions: [],
      openQuestions: [],
      resources: [{ kind: 'document', title: 'bad', url: 'https://example.com/?token=secret', description: '' }],
      reason: '',
    })).toThrow('invalid_output');
  });
});
