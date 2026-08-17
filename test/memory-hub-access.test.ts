import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMemoryHubLoginUrl } from '../src/services/memory-hub-access.js';
import { resolveTopicGroupMemoryConfig } from '../src/services/topic-group-memory-config.js';

const dirs: string[] = [];

async function runtimeWithAdminKey(userKey = 'sk-mem-test_key_abcdefghijklmnopqrstuvwxyz'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'botmux-memory-hub-'));
  dirs.push(root);
  const hub = join(root, '.runtime', 'hub');
  await mkdir(hub, { recursive: true, mode: 0o700 });
  await chmod(hub, 0o700);
  const keyPath = join(hub, 'admin-user-key');
  await writeFile(keyPath, `${userKey}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  return root;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Memory Hub one-click access URL', () => {
  it('reads the hub admin user key only at click time and carries it in the URL fragment', async () => {
    const runtimeDir = await runtimeWithAdminKey('sk-mem-abcdefghijklmnopqrstuvwxyz012345');
    const config = resolveTopicGroupMemoryConfig({
      tencentdb: {
        runtimeDir,
        panelUrl: 'http://10.0.0.8:8125',
        serviceId: 'botmux-local',
      },
    }).tencentdb;

    const url = new URL(buildMemoryHubLoginUrl(config));

    expect(`${url.protocol}//${url.host}`).toBe('http://10.0.0.8:8125');
    expect(url.search).toBe('');
    expect(url.hash).toContain('/memory?');
    expect(url.hash).toContain('user_key=sk-mem-abcdefghijklmnopqrstuvwxyz012345');
    expect(url.hash).toContain('instance_id=botmux-local');
  });

  it('rejects panel URLs with pre-existing query strings or fragments', async () => {
    const runtimeDir = await runtimeWithAdminKey();
    const config = resolveTopicGroupMemoryConfig({
      tencentdb: {
        runtimeDir,
        panelUrl: 'http://127.0.0.1:8125/?token=leak',
      },
    }).tencentdb;

    expect(() => buildMemoryHubLoginUrl(config)).toThrow(/panelUrl/);
  });
});
