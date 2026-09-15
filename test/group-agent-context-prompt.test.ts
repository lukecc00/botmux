import { describe, expect, it } from 'vitest';
import { buildFollowUpCliInput, buildNewTopicCliInput, buildReforkCliInput } from '../src/core/session-manager.js';

const groupContext = '<group_agent_context source="lark" trust="untrusted"><announcement status="ok">PPE 链接</announcement></group_agent_context>';
const topicMemory = '<topic_group_memory><summary>topic memory</summary></topic_group_memory>';

describe('group-agent-context prompt injection', () => {
  it('places group context after topic memory and before the opening user message', () => {
    const input = buildNewTopicCliInput('current request', 'session_x', 'codex', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      topicGroupMemoryBlock: topicMemory,
      groupAgentContextBlock: groupContext,
    });
    expect(input.content.indexOf('<topic_group_memory')).toBeLessThan(input.content.indexOf('<group_agent_context'));
    expect(input.content.indexOf('<group_agent_context')).toBeLessThan(input.content.indexOf('<user_message>'));
  });

  it('injects follow-up group context into legacy prompt and Codex App untrusted sidecar', () => {
    const legacy = buildFollowUpCliInput('next request', 'session_x', {
      cliId: 'codex',
      groupAgentContextBlock: groupContext,
    });
    expect(legacy.content.indexOf('<group_agent_context')).toBeLessThan(legacy.content.indexOf('<user_message>'));

    const app = buildFollowUpCliInput('next request', 'session_x', {
      cliId: 'codex-app',
      groupAgentContextBlock: groupContext,
    });
    expect(app.codexAppInput?.additionalContext?.botmux_group_agent_context).toEqual({
      kind: 'untrusted',
      value: groupContext,
    });
  });

  it('preserves group context on refork for non-adopted sessions', () => {
    const built = buildReforkCliInput({
      larkAppId: 'app_ctx',
      session: { sessionId: 'sid_refork', chatId: 'oc_chat', backendType: 'pty' },
    } as any, 'refork request', {
      cliId: 'codex-app',
      groupAgentContextBlock: groupContext,
      codexAppText: 'refork request',
    });
    expect(built.content).toContain(groupContext);
    expect(built.codexAppInput?.additionalContext?.botmux_group_agent_context?.kind).toBe('untrusted');
  });
});
