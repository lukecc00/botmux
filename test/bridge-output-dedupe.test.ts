import { describe, expect, it } from 'vitest';
import { bridgeProgressProviderUuid } from '../src/services/bridge-output-dedupe.js';

describe('bridge output provider UUID', () => {
  it('coalesces explicit and native delivery after whitespace normalization', () => {
    const native = bridgeProgressProviderUuid(
      'session-a',
      'turn-a',
      '刷新后发现远端源分支已被删除：\n提交对象仍在本地。',
    );
    const explicit = bridgeProgressProviderUuid(
      'session-a',
      'turn-a',
      '刷新后发现远端源分支已被删除：  提交对象仍在本地。',
    );
    expect(native).toBe(explicit);
    expect(native).toMatch(/^bmxp_[0-9a-f]{40}$/);
    expect(native!.length).toBeLessThanOrEqual(50);
  });

  it('does not coalesce a later turn or different content', () => {
    const base = bridgeProgressProviderUuid('session-a', 'turn-a', '阶段结论');
    expect(bridgeProgressProviderUuid('session-a', 'turn-b', '阶段结论')).not.toBe(base);
    expect(bridgeProgressProviderUuid('session-a', 'turn-a', '另一个阶段结论')).not.toBe(base);
  });

  it('declines an empty unscoped payload', () => {
    expect(bridgeProgressProviderUuid('session-a', 'turn-a', '  \n ')).toBeUndefined();
    expect(bridgeProgressProviderUuid('session-a', '', '正文')).toBeUndefined();
  });
});
