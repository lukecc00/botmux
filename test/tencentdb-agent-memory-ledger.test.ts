import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureTencentDbTurnOnce } from '../src/services/tencentdb-agent-memory-ledger.js';

const dirs: string[] = [];
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botmux-tdai-ledger-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('TencentDB capture success ledger', () => {
  it('captures a successful turn once across replays', async () => {
    const dir = await dataDir();
    const capture = vi.fn(async () => 'accepted');
    expect(await captureTencentDbTurnOnce('app:chat', 'turn-1', capture, { dataDir: dir }))
      .toMatchObject({ captured: true, result: 'accepted' });
    expect(await captureTencentDbTurnOnce('app:chat', 'turn-1', capture, { dataDir: dir }))
      .toEqual({ captured: false });
    expect(capture).toHaveBeenCalledOnce();
  });

  it('does not mark a failed provider request as captured', async () => {
    const dir = await dataDir();
    await expect(captureTencentDbTurnOnce('app:chat', 'turn-1', async () => {
      throw new Error('offline');
    }, { dataDir: dir })).rejects.toThrow('offline');
    const retry = vi.fn(async () => 'accepted');
    expect(await captureTencentDbTurnOnce('app:chat', 'turn-1', retry, { dataDir: dir }))
      .toMatchObject({ captured: true });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('serializes concurrent attempts for the same turn', async () => {
    const dir = await dataDir();
    const capture = vi.fn(async () => 'accepted');
    const results = await Promise.all(Array.from({ length: 8 }, () => (
      captureTencentDbTurnOnce('app:chat', 'turn-1', capture, { dataDir: dir })
    )));
    expect(results.filter(result => result.captured)).toHaveLength(1);
    expect(capture).toHaveBeenCalledOnce();
  });
});
