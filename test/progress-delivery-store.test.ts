import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completeProgressDelivery,
  listProgressDeliveries,
  progressProviderUuid,
  stageProgressDelivery,
} from '../src/services/progress-delivery-store.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-progress-outbox-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('progress delivery outbox', () => {
  it('persists separate tool-before and tool-after commentary in emission order', () => {
    const dataDir = tempDir();
    const base = { sessionId: 'session-1', turnId: 'turn-1' };
    const first = stageProgressDelivery(dataDir, {
      ...base,
      transcriptUuid: 'commentary-before-tool',
      content: '已核对原生 XML 和 Holder。',
    });
    const second = stageProgressDelivery(dataDir, {
      ...base,
      transcriptUuid: 'commentary-after-tool',
      content: '已完成首轮修复并开始构建。',
    });

    expect(listProgressDeliveries(dataDir, base.sessionId)).toEqual([first, second]);
    expect(progressProviderUuid(base.sessionId, first.transcriptUuid))
      .not.toBe(progressProviderUuid(base.sessionId, second.transcriptUuid));
  });

  it('stages duplicate IPC idempotently and removes only the confirmed record', () => {
    const dataDir = tempDir();
    const input = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      transcriptUuid: 'commentary-1',
      content: '一次性过程消息',
    };
    const first = stageProgressDelivery(dataDir, input);
    const duplicate = stageProgressDelivery(dataDir, { ...input, content: 'late duplicate payload' });

    expect(duplicate).toEqual(first);
    expect(listProgressDeliveries(dataDir, input.sessionId)).toEqual([first]);
    completeProgressDelivery(dataDir, input.sessionId, input.transcriptUuid);
    expect(listProgressDeliveries(dataDir, input.sessionId)).toEqual([]);
  });
});
