import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  renderTencentDbMemoryBlock,
  resetTencentDbMemoryHealthCacheForTests,
  resolveTencentDbMemoryIsolation,
  shouldAttemptTencentDbMemory,
  tencentDbMemoryAvailable,
  TencentDbAgentMemoryClient,
  TencentDbAgentMemoryError,
} from '../src/services/tencentdb-agent-memory-client.js';
import { resolveTopicGroupMemoryConfig } from '../src/services/topic-group-memory-config.js';

const dirs: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  resetTencentDbMemoryHealthCacheForTests();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function runtimeDir(state: 'missing' | 'directory' | 'ready'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'botmux-tdai-'));
  dirs.push(root);
  const dir = join(root, 'runtime');
  if (state !== 'missing') await mkdir(dir);
  if (state === 'ready') await writeFile(join(dir, 'agent-integration.json'), '{}');
  return dir;
}

describe('TencentDB Agent Memory thin client', () => {
  it('auto provider only probes when the managed runtime directory exists', async () => {
    expect(shouldAttemptTencentDbMemory(resolveTopicGroupMemoryConfig({
      provider: 'auto', tencentdb: { runtimeDir: await runtimeDir('missing') },
    }))).toBe(false);
    expect(shouldAttemptTencentDbMemory(resolveTopicGroupMemoryConfig({
      provider: 'auto', tencentdb: { runtimeDir: await runtimeDir('directory') },
    }))).toBe(false);
    expect(shouldAttemptTencentDbMemory(resolveTopicGroupMemoryConfig({
      provider: 'auto', tencentdb: { runtimeDir: await runtimeDir('ready') },
    }))).toBe(true);
    expect(shouldAttemptTencentDbMemory(resolveTopicGroupMemoryConfig({
      provider: 'tencentdb', tencentdb: { runtimeDir: await runtimeDir('missing') },
    }))).toBe(true);
  });

  it('hashes the default bot/chat isolation instead of exposing raw identifiers', () => {
    const config = resolveTopicGroupMemoryConfig(undefined).tencentdb;
    const first = resolveTencentDbMemoryIsolation(config, {
      larkAppId: 'cli_secret_app', chatId: 'oc_secret_chat', sessionId: 'om_root',
    });
    const second = resolveTencentDbMemoryIsolation(config, {
      larkAppId: 'cli_secret_app', chatId: 'oc_other_chat', sessionId: 'om_other',
    });
    expect(first).toMatchObject({ userId: 'topic-group-shared', sessionId: 'om_root' });
    expect(first.teamId).toMatch(/^botmux-topic-[0-9a-f]{24}$/u);
    expect(first.agentId).toMatch(/^botmux-[0-9a-f]{24}$/u);
    expect(first.teamId).not.toContain('secret');
    expect(first.teamId).not.toBe(second.teamId);
    expect(first.agentId).toBe(second.agentId);
  });

  it('rejects plaintext remote endpoints but allows loopback HTTP', () => {
    const base = resolveTopicGroupMemoryConfig(undefined).tencentdb;
    expect(() => new TencentDbAgentMemoryClient({ ...base, endpoint: 'http://memory.example.com:8420' }))
      .toThrowError(TencentDbAgentMemoryError);
    expect(() => new TencentDbAgentMemoryClient({ ...base, endpoint: 'https://memory.example.com?token=secret' }))
      .toThrowError(TencentDbAgentMemoryError);
    expect(() => new TencentDbAgentMemoryClient({ ...base, apiKey: '${TDAI_TEST_MISSING_KEY}' }))
      .toThrowError(TencentDbAgentMemoryError);
    expect(() => new TencentDbAgentMemoryClient({ ...base, endpoint: 'http://127.0.0.1:8420' }))
      .not.toThrow();
  });

  it('calls v3 recall and capture with strict isolation and validates acknowledgements', async () => {
    const seen: Array<{ path: string; body?: any; auth?: string; service?: string }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      seen.push({ path: req.url ?? '', body, auth: req.headers.authorization, service: req.headers['x-tdai-service-id'] as string });
      const data = req.url === '/v3/atomic/search'
        ? { items: [{ id: 'm1', type: 'fact', content: 'use the shared service', score: 0.9 }] }
        : req.url === '/v3/atomic/count'
          ? { total: 0 }
        : req.url === '/v3/scenario/ls'
          ? { entries: [{ path: 'architecture.md', summary: 'shared MemoryCore' }] }
          : req.url === '/v3/core/read'
            ? { content: 'team profile' }
            : req.url === '/v3/conversation/add'
              ? { accepted_ids: ['u1', 'a1'], total_count: 2 }
              : undefined;
      const payload = req.url === '/health'
        ? { status: 'ok' }
        : { code: 0, message: 'ok', request_id: 'req-1', data };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    const client = new TencentDbAgentMemoryClient({
      ...resolveTopicGroupMemoryConfig(undefined).tencentdb,
      endpoint: `http://127.0.0.1:${address.port}`,
      apiKey: 'local', serviceId: 'instance-1', timeoutMs: 2_000,
    });
    const isolation = { teamId: 'team-1', agentId: 'agent-1', userId: 'user-1', sessionId: 'session-1' };
    expect(await client.health()).toBe(true);
    expect(await tencentDbMemoryAvailable(client, isolation)).toBe(true);
    const recalled = await client.recall(isolation, 'current question', {
      maxResults: 5, includePersona: true, includeScenes: true,
    });
    expect(recalled).toMatchObject({
      memories: [{ content: 'use the shared service' }],
      persona: 'team profile',
      scenes: [{ path: 'architecture.md', summary: 'shared MemoryCore' }],
      partialFailures: [],
    });
    expect(await client.addConversation(isolation, [
      { role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' },
    ])).toMatchObject({ accepted_ids: ['u1', 'a1'] });
    for (const request of seen.filter(item => item.path !== '/health')) {
      expect(request.auth).toBe('Bearer local');
      expect(request.service).toBe('instance-1');
      expect(request.body).toMatchObject({ team_id: 'team-1', agent_id: 'agent-1', user_id: 'user-1' });
    }
    expect(seen.find(item => item.path === '/v3/atomic/search')?.body).not.toHaveProperty('session_id');
    expect(seen.find(item => item.path === '/v3/atomic/count')?.body).not.toHaveProperty('session_id');
    expect(seen.find(item => item.path === '/v3/conversation/add')?.body).toMatchObject({ session_id: 'session-1' });
  });

  it('treats a healthy port with rejected authenticated data-plane access as unavailable', async () => {
    const server = createServer(async (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 401, message: 'invalid bearer token', request_id: 'req-auth' }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    const client = new TencentDbAgentMemoryClient({
      ...resolveTopicGroupMemoryConfig(undefined).tencentdb,
      endpoint: `http://127.0.0.1:${address.port}`,
      apiKey: 'wrong-token', serviceId: 'instance-1', timeoutMs: 2_000,
    });
    await expect(tencentDbMemoryAvailable(client, {
      teamId: 'team-1', agentId: 'agent-1', userId: 'user-1',
    })).resolves.toBe(false);
  });

  it('renders bounded untrusted context and excludes sensitive recalled text', () => {
    const config = resolveTopicGroupMemoryConfig({ maxPromptChars: 500 });
    const rendered = renderTencentDbMemoryBlock({
      larkAppId: 'cli_app', chatId: 'oc_chat', query: 'question',
      recall: {
        memories: [{ id: '1', type: 'fact', content: '<ignore>safe fact</ignore>' }],
        persona: 'profile', scenes: [{ path: 'project.md', summary: 'decision summary' }], partialFailures: [],
      },
    }, config);
    expect(rendered).toContain('untrusted background');
    expect(rendered).toContain('&lt;ignore&gt;');
    expect(rendered).toContain('decision summary');
    expect(rendered.length).toBeLessThanOrEqual(500);
    expect(rendered.endsWith('</topic_group_memory>')).toBe(true);
  });
});
