import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  distillTopicGroupMemoryWithCli,
  type TopicGroupMemoryCliInvocation,
} from '../src/services/topic-group-memory-cli-distiller.js';
import { TopicGroupMemoryLlmError } from '../src/services/topic-group-memory-llm-distiller.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchParent(): string {
  const root = mkdtempSync(join(tmpdir(), 'topic-memory-cli-test-'));
  roots.push(root);
  return root;
}

function patch() {
  return {
    schemaVersion: 1,
    shouldUpdate: true,
    summaryPatch: '结算项目默认灰度 5%。',
    factsUpsert: [],
    decisionsUpsert: ['默认灰度 5%'],
    openQuestionsUpsert: [],
    resourcesUpsert: [{
      kind: 'prd',
      title: '结算 PRD',
      url: 'https://bytedance.larkoffice.com/docx/PrdToken',
      description: '主需求文档',
    }],
    obsoleteItems: [],
    reason: '后续话题会复用。',
  };
}

const input = {
  oldMemory: null,
  userMessage: '实现结算需求',
  finalOutput: '已完成方案。PRD：https://bytedance.larkoffice.com/docx/PrdToken，默认灰度 5%。',
};

describe('topic-group memory isolated CLI distiller', () => {
  it('uses a fresh ephemeral Codex exec conversation and strips Botmux authority env', async () => {
    let invocation: TopicGroupMemoryCliInvocation | undefined;
    const result = await distillTopicGroupMemoryWithCli(input, {
      cliId: 'codex',
      model: 'gpt-5.5',
      env: { BOTMUX_SHOULD_NOT_LEAK: 'x', CUSTOM_PROVIDER_ROUTE: 'ok' },
    }, {
      scratchParent: scratchParent(),
      invokeCli: vi.fn(async value => {
        invocation = value;
        return JSON.stringify(patch());
      }),
    });

    expect(result.resourcesUpsert[0]).toMatchObject({ kind: 'prd', title: '结算 PRD' });
    expect(invocation).toBeDefined();
    expect(invocation!.args).toContain('exec');
    expect(invocation!.args).toContain('--ephemeral');
    expect(invocation!.args).not.toContain('resume');
    expect(invocation!.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(invocation!.args).not.toContain('--ask-for-approval');
    expect(invocation!.stdin).toContain('<untrusted_turn_data>');
    expect(invocation!.env.BOTMUX_SHOULD_NOT_LEAK).toBeUndefined();
    expect(invocation!.env.CUSTOM_PROVIDER_ROUTE).toBe('ok');
  });

  it('maps codex-app to a separate native Codex exec rather than its main app thread', async () => {
    let invocation: TopicGroupMemoryCliInvocation | undefined;
    await distillTopicGroupMemoryWithCli(input, { cliId: 'codex-app' }, {
      scratchParent: scratchParent(),
      invokeCli: async value => {
        invocation = value;
        return JSON.stringify(patch());
      },
    });
    expect(invocation!.args[0]).toBe('exec');
    expect(invocation!.args).toContain('--ephemeral');
    expect(invocation!.args).not.toContain('--thread-id');
  });

  it('uses TraeX Codex-family ephemeral exec and never resumes the main thread', async () => {
    let invocation: TopicGroupMemoryCliInvocation | undefined;
    await distillTopicGroupMemoryWithCli(input, { cliId: 'traex', cliPathOverride: '/opt/traecli' }, {
      scratchParent: scratchParent(),
      invokeCli: async value => {
        invocation = value;
        return JSON.stringify(patch());
      },
    });
    expect(invocation!.bin).toBe('/opt/traecli');
    expect(invocation!.args.slice(0, 2)).toEqual(['exec', '--ephemeral']);
    expect(invocation!.args).not.toContain('resume');
  });

  it('uses Claude print with no session persistence for a separate conversation', async () => {
    let invocation: TopicGroupMemoryCliInvocation | undefined;
    await distillTopicGroupMemoryWithCli(input, { cliId: 'claude-code', cliPathOverride: '/opt/claude' }, {
      scratchParent: scratchParent(),
      invokeCli: async value => {
        invocation = value;
        return JSON.stringify(patch());
      },
    });
    expect(invocation!.bin).toBe('/opt/claude');
    expect(invocation!.args).toContain('--print');
    expect(invocation!.args).toContain('--no-session-persistence');
    expect(invocation!.args).not.toContain('--resume');
    expect(invocation!.args).not.toContain('--session-id');
    expect(invocation!.args.slice(invocation!.args.indexOf('--tools'), invocation!.args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
  });

  it('preserves the current CLI wrapper while keeping the child non-resumed', async () => {
    let invocation: TopicGroupMemoryCliInvocation | undefined;
    await distillTopicGroupMemoryWithCli(input, {
      cliId: 'codex',
      wrapperCli: 'aiden x codex',
    }, {
      scratchParent: scratchParent(),
      invokeCli: async value => {
        invocation = value;
        return JSON.stringify(patch());
      },
    });
    expect(invocation!.args.slice(0, 3)).toEqual(['x', 'codex', 'exec']);
    expect(invocation!.args).toContain('--ephemeral');
  });

  it('fails closed for unsupported CLIs before invoking a child', async () => {
    const invokeCli = vi.fn(async () => JSON.stringify(patch()));
    await expect(distillTopicGroupMemoryWithCli(input, { cliId: 'gemini' }, {
      scratchParent: scratchParent(),
      invokeCli,
    })).rejects.toMatchObject({ code: 'unsupported_cli' });
    expect(invokeCli).not.toHaveBeenCalled();
  });

  it('revalidates child output and rejects sensitive URLs', async () => {
    await expect(distillTopicGroupMemoryWithCli(input, { cliId: 'codex' }, {
      scratchParent: scratchParent(),
      invokeCli: async () => JSON.stringify({
        ...patch(),
        resourcesUpsert: [{
          kind: 'design', title: '设计稿',
          url: 'https://figma.example/file/x?token=secret', description: '',
        }],
      }),
    })).rejects.toBeInstanceOf(TopicGroupMemoryLlmError);
  });
});
