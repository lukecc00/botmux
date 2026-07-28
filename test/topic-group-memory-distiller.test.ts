import { describe, expect, it } from 'vitest';
import { distillTopicGroupMemoryRules } from '../src/services/topic-group-memory-distiller.js';

describe('topic-group memory rule distiller', () => {
  it('records a bounded contribution and explicit structured marker items', () => {
    const patch = distillTopicGroupMemoryRules(`已完成共享记忆第一阶段，并通过全部测试。\n\nPRD 链接：https://bytedance.larkoffice.com/docx/PrdToken\nPPE 环境：https://ppe.example.com/app?env=ppe\n\n【共享记忆】\n事实：存储键包含 larkAppId + chatId\n决策：默认关闭\n待确认：何时接入 LLM 蒸馏`);
    expect(patch?.contributionSummary).toContain('已完成共享记忆第一阶段');
    expect(patch?.facts).toEqual(['存储键包含 larkAppId + chatId']);
    expect(patch?.decisions).toEqual(['默认关闭']);
    expect(patch?.openQuestions).toEqual(['何时接入 LLM 蒸馏']);
    expect(patch?.resources.map(item => item.kind)).toEqual(['prd', 'ppe']);
  });

  it('does not extract sensitive resource URLs', () => {
    const patch = distillTopicGroupMemoryRules('设计稿链接：https://figma.example.com/file/abc?token=secretvalue 已确认后续使用。');
    expect(patch).toBeNull();
  });

  it('does not promote secrets from an explicit marker', () => {
    const patch = distillTopicGroupMemoryRules(`已完成凭证配置与验证，后续可以继续运行。\n【共享记忆】\n事实：Authorization: Bearer abcdefghijklmnopqrstuvwxyz`);
    expect(patch).toBeNull();
  });

  it('does not persist an ordinary final when every LLM provider failed', () => {
    expect(distillTopicGroupMemoryRules('Fix the backend panel based on the screenshot and request.')).toBeNull();
    expect(distillTopicGroupMemoryRules('当前这套模式下，不是定时触发，而是每轮结束后自动尝试。')).toBeNull();
  });

  it('skips very short finals', () => {
    expect(distillTopicGroupMemoryRules('完成')).toBeNull();
  });
});
