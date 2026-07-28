import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllTopicGroupMemories,
  clearTopicGroupMemory,
  clearTopicGroupMemoriesForChat,
  compactTopicGroupMemory,
  listTopicGroupMemories,
  mutateTopicGroupMemory,
  readTopicGroupMemory,
  statTopicGroupMemory,
  topicGroupMemoryPath,
  updateTopicGroupMemory,
} from '../src/services/topic-group-memory-store.js';

const dirs: string[] = [];
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botmux-tgm-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('topic-group memory store', () => {
  it('isolates bot and topic-group keys', async () => {
    const dir = await dataDir();
    await mutateTopicGroupMemory('cli_a', 'oc_one', doc => { doc.summary = 'alpha'; }, { dataDir: dir });
    expect((await readTopicGroupMemory('cli_a', 'oc_one', { dataDir: dir }))?.summary).toBe('alpha');
    expect(await readTopicGroupMemory('cli_b', 'oc_one', { dataDir: dir })).toBeNull();
    expect(await readTopicGroupMemory('cli_a', 'oc_two', { dataDir: dir })).toBeNull();
  });

  it('normalizes and persists safe resources while dropping sensitive URLs', async () => {
    const dir = await dataDir();
    await mutateTopicGroupMemory('cli_a', 'oc_one', doc => {
      doc.resources.push({
        id: 'resource_1', kind: 'design', title: 'Design',
        url: 'https://figma.example.com/file/abc#secret-fragment', description: '主设计稿',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confidence: 'confirmed',
      });
      doc.resources.push({
        id: 'resource_2', kind: 'prd', title: 'Bad',
        url: 'https://docs.example.com/prd?token=secret',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confidence: 'confirmed',
      });
    }, { dataDir: dir });
    const doc = await readTopicGroupMemory('cli_a', 'oc_one', { dataDir: dir });
    expect(doc?.resources).toHaveLength(1);
    expect(doc?.resources[0]).toMatchObject({ kind: 'design', url: 'https://figma.example.com/file/abc' });
  });

  it('filters sensitive text at the durable store boundary', async () => {
    const dir = await dataDir();
    await mutateTopicGroupMemory('cli_a', 'oc_one', doc => {
      doc.summary = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz';
      doc.facts.push({
        id: 'fact_secret', text: '联系人 user@example.com', createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), confidence: 'confirmed',
      });
      doc.decisions.push({ id: 'decision_safe', text: '共享记忆默认关闭', createdAt: new Date().toISOString() });
      doc.resources.push({
        id: 'resource_secret', kind: 'document', title: '联系 user@example.com', url: 'https://docs.example.com/safe',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confidence: 'confirmed',
      });
    }, { dataDir: dir });

    const doc = await readTopicGroupMemory('cli_a', 'oc_one', { dataDir: dir });
    expect(doc?.summary).toBe('');
    expect(doc?.facts).toEqual([]);
    expect(doc?.resources).toEqual([]);
    expect(doc?.decisions.map(item => item.text)).toEqual(['共享记忆默认关闭']);
  });

  it('serializes concurrent appends without losing data', async () => {
    const dir = await dataDir();
    await Promise.all(Array.from({ length: 20 }, (_, index) => mutateTopicGroupMemory('cli_a', 'oc_one', doc => {
      doc.recentContributions.push({ turnId: `turn_${index}`, sessionId: `session_${index}`, rootMessageId: `om_${index}`, summary: `value ${index}`, createdAt: new Date().toISOString() });
    }, { dataDir: dir })));
    const doc = await readTopicGroupMemory('cli_a', 'oc_one', { dataDir: dir });
    expect(doc?.revision).toBe(20);
    expect(new Set(doc?.recentContributions.map(item => item.turnId))).toHaveLength(20);
    expect(JSON.parse(await readFile(topicGroupMemoryPath('cli_a', 'oc_one', { dataDir: dir }), 'utf8')).schemaVersion).toBe(1);
  });

  it('enforces CAS revisions', async () => {
    const dir = await dataDir();
    const first = await updateTopicGroupMemory('cli_a', 'oc_one', 0, doc => { doc.summary = 'one'; }, { dataDir: dir });
    expect(first.ok).toBe(true);
    const stale = await updateTopicGroupMemory('cli_a', 'oc_one', 0, doc => { doc.summary = 'stale'; }, { dataDir: dir });
    expect(stale).toMatchObject({ ok: false, reason: 'revision_mismatch' });
    expect((await readTopicGroupMemory('cli_a', 'oc_one', { dataDir: dir }))?.summary).toBe('one');
  });

  it('does not bump revision for an explicit no-op update', async () => {
    const dir = await dataDir();
    const first = await mutateTopicGroupMemory('cli_a', 'oc_one', doc => { doc.summary = 'one'; }, { dataDir: dir });
    const second = await mutateTopicGroupMemory('cli_a', 'oc_one', () => false, { dataDir: dir });
    expect(second.revision).toBe(first.revision);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it('clear is safe before and after a document exists', async () => {
    const dir = await dataDir();
    expect(await clearTopicGroupMemory('cli_a', 'oc_one', { dataDir: dir })).toBe(false);
    await mutateTopicGroupMemory('cli_a', 'oc_one', doc => { doc.summary = 'one'; }, { dataDir: dir });
    expect(await clearTopicGroupMemory('cli_a', 'oc_one', { dataDir: dir })).toBe(true);
    expect(await readTopicGroupMemory('cli_a', 'oc_one', { dataDir: dir })).toBeNull();
  });

  it('clears a dissolved chat across every bot partition without touching other chats', async () => {
    const dir = await dataDir();
    await mutateTopicGroupMemory('cli_a', 'oc_shared', doc => { doc.summary = 'a'; }, { dataDir: dir });
    await mutateTopicGroupMemory('cli_b', 'oc_shared', doc => { doc.summary = 'b'; }, { dataDir: dir });
    await mutateTopicGroupMemory('cli_a', 'oc_keep', doc => { doc.summary = 'keep'; }, { dataDir: dir });

    const cleared = await clearTopicGroupMemoriesForChat('oc_shared', { dataDir: dir });

    expect(cleared).toHaveLength(2);
    expect(cleared.map(item => item.larkAppId).sort()).toEqual(['cli_a', 'cli_b']);
    expect(cleared.every(item => item.chatId === 'oc_shared' && item.cleared)).toBe(true);
    expect(await readTopicGroupMemory('cli_a', 'oc_shared', { dataDir: dir })).toBeNull();
    expect(await readTopicGroupMemory('cli_b', 'oc_shared', { dataDir: dir })).toBeNull();
    expect((await readTopicGroupMemory('cli_a', 'oc_keep', { dataDir: dir }))?.summary).toBe('keep');
  });

  it('clears every memory file for one bot without touching another bot partition', async () => {
    const dir = await dataDir();
    await mutateTopicGroupMemory('cli_a', 'oc_one', doc => { doc.summary = 'one'; }, { dataDir: dir });
    await mutateTopicGroupMemory('cli_a', 'oc_two', doc => { doc.summary = 'two'; }, { dataDir: dir });
    await mutateTopicGroupMemory('cli_b', 'oc_one', doc => { doc.summary = 'other'; }, { dataDir: dir });

    const cleared = await clearAllTopicGroupMemories('cli_a', { dataDir: dir });

    expect(cleared).toHaveLength(2);
    expect(cleared.map(item => item.chatId).sort()).toEqual(['oc_one', 'oc_two']);
    expect(await listTopicGroupMemories('cli_a', { dataDir: dir })).toEqual([]);
    expect((await readTopicGroupMemory('cli_b', 'oc_one', { dataDir: dir }))?.summary).toBe('other');
  });

  it('lists per-bot memory statistics with file size and entry counts', async () => {
    const dir = await dataDir();
    await mutateTopicGroupMemory('cli_a', 'oc_one', doc => {
      doc.summary = 'shared summary';
      doc.facts.push({ id: 'fact_1', text: 'fact', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confidence: 'confirmed' });
      doc.resources.push({ id: 'resource_1', kind: 'prd', title: 'PRD', url: 'https://docs.example.com/prd', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confidence: 'confirmed' });
    }, { dataDir: dir });
    await mutateTopicGroupMemory('cli_b', 'oc_two', doc => { doc.summary = 'other bot'; }, { dataDir: dir });

    const listed = await listTopicGroupMemories('cli_a', { dataDir: dir });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      larkAppId: 'cli_a', chatId: 'oc_one', exists: true, hasContent: true,
      revision: 1, summaryChars: 14, facts: 1, resources: 1,
    });
    expect(listed[0].sizeBytes).toBeGreaterThan(0);
    expect((await listTopicGroupMemories(undefined, { dataDir: dir })).map(item => item.larkAppId).sort()).toEqual(['cli_a', 'cli_b']);
    expect(await statTopicGroupMemory('cli_a', 'missing', { dataDir: dir })).toMatchObject({ exists: false, sizeBytes: 0 });
  });

  it('compacts duplicates using the newest entry and does not bump a no-op revision', async () => {
    const dir = await dataDir();
    const first = await mutateTopicGroupMemory('cli_a', 'oc_one', doc => {
      doc.summary = 'One paragraph\n\nTwo paragraphs\n\n one paragraph ';
      doc.facts.push(
        { id: 'fact_old', text: 'Same fact', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', confidence: 'confirmed' },
        { id: 'fact_new', text: ' same   fact ', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', confidence: 'confirmed' },
      );
      doc.resources.push(
        { id: 'resource_old', kind: 'document', title: 'Old', url: 'https://docs.example.com/a#old', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', confidence: 'confirmed' },
        { id: 'resource_new', kind: 'prd', title: 'New', url: 'https://docs.example.com/a', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', confidence: 'confirmed' },
      );
    }, { dataDir: dir });

    const compacted = await compactTopicGroupMemory('cli_a', 'oc_one', { dataDir: dir });
    expect(compacted.compacted).toBe(true);
    expect(compacted.doc?.revision).toBe(first.revision + 1);
    expect(compacted.doc?.summary).toBe('稳定背景：same fact；Two paragraphs；one paragraph。');
    expect(compacted.doc?.facts.map(item => item.id)).toEqual(['fact_new']);
    expect(compacted.doc?.resources.map(item => item.id)).toEqual(['resource_new']);

    const noOp = await compactTopicGroupMemory('cli_a', 'oc_one', { dataDir: dir });
    expect(noOp.compacted).toBe(false);
    expect(noOp.doc?.revision).toBe(compacted.doc?.revision);
  });

  it('prefers an HTTP LLM full-document compaction and preserves matching metadata', async () => {
    const dir = await dataDir();
    const first = await mutateTopicGroupMemory('cli_a', 'oc_one', doc => {
      doc.summary = 'old verbose summary';
      doc.facts.push({
        id: 'fact_keep', text: '共享记忆按 bot 和 chat 隔离', sourceRootMessageId: 'root_1', sourceSessionId: 'session_1',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', confidence: 'confirmed',
      });
      doc.resources.push({
        id: 'resource_keep', kind: 'document', title: 'Memory design', url: 'https://docs.example.com/memory',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', confidence: 'confirmed',
      });
    }, { dataDir: dir });
    const compactWithHttp = vi.fn(async () => ({
      schemaVersion: 1 as const,
      summary: '共享记忆按 bot 与 chat 隔离。',
      facts: ['共享记忆按 bot 与 chat 隔离'],
      decisions: ['后台压缩优先使用本地 HTTP LLM'],
      openQuestions: [],
      resources: [
        { kind: 'design' as const, title: '共享记忆设计', url: 'https://docs.example.com/memory', description: '实现基线' },
        { kind: 'document' as const, title: 'Invented', url: 'https://evil.example.com/new', description: '' },
      ],
      reason: '去重并保留稳定信息。',
    }));

    const compacted = await compactTopicGroupMemory('cli_a', 'oc_one', {
      dataDir: dir,
      httpContext: { baseUrl: 'http://127.0.0.1:8787/v1', model: 'local', api: 'responses', timeoutMs: 1_000 },
      compactWithHttp,
    });

    expect(compactWithHttp).toHaveBeenCalledOnce();
    expect(compacted).toMatchObject({ compacted: true, source: 'http' });
    expect(compacted.doc?.revision).toBe(first.revision + 1);
    expect(compacted.doc?.summary).toBe('共享记忆按 bot 与 chat 隔离。');
    expect(compacted.doc?.facts[0]).toMatchObject({ id: 'fact_keep', sourceRootMessageId: 'root_1', confidence: 'confirmed' });
    expect(compacted.doc?.decisions).toHaveLength(1);
    expect(compacted.doc?.resources).toHaveLength(1);
    expect(compacted.doc?.resources[0]).toMatchObject({ id: 'resource_keep', kind: 'design', title: '共享记忆设计' });

    const noOp = await compactTopicGroupMemory('cli_a', 'oc_one', {
      dataDir: dir,
      httpContext: { baseUrl: 'http://127.0.0.1:8787/v1', model: 'local', api: 'responses', timeoutMs: 1_000 },
      compactWithHttp,
    });
    expect(noOp).toMatchObject({ compacted: false, source: 'http' });
    expect(noOp.doc?.revision).toBe(compacted.doc?.revision);
  });

  it('falls back to local semantic compaction when the HTTP LLM fails', async () => {
    const dir = await dataDir();
    await mutateTopicGroupMemory('cli_a', 'oc_one', doc => {
      doc.summary = 'duplicate\n\nduplicate';
      doc.facts.push(
        { id: 'old', text: 'same fact', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', confidence: 'confirmed' },
        { id: 'new', text: ' same  fact ', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', confidence: 'confirmed' },
      );
    }, { dataDir: dir });

    const compacted = await compactTopicGroupMemory('cli_a', 'oc_one', {
      dataDir: dir,
      httpContext: { baseUrl: 'http://127.0.0.1:8787/v1', model: 'local', api: 'responses', timeoutMs: 1_000 },
      compactWithHttp: vi.fn(async () => { throw new Error('offline'); }),
    });

    expect(compacted).toMatchObject({ compacted: true, source: 'local', fallbackReason: 'http:Error' });
    expect(compacted.doc?.facts.map(item => item.id)).toEqual(['new']);
  });
});
