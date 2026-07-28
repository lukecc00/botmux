import { describe, expect, it } from 'vitest';
import { buildFollowUpCliInput, buildNewTopicCliInput } from '../src/core/session-manager.js';
import { createEmptyTopicGroupMemory } from '../src/services/topic-group-memory-store.js';
import { renderTopicGroupMemoryBlock } from '../src/services/topic-group-memory-renderer.js';

function block() {
  const doc = createEmptyTopicGroupMemory('cli_app', 'oc_chat');
  doc.revision = 2;
  doc.summary = 'Shared project background';
  doc.resources.push({ id: 'resource_1', kind: 'prd', title: 'Main PRD', url: 'https://bytedance.larkoffice.com/docx/PrdToken', description: 'Requirement doc', createdAt: doc.updatedAt, updatedAt: doc.updatedAt, confidence: 'confirmed' });
  doc.facts.push({ id: 'fact_1', text: 'API uses v2', createdAt: doc.updatedAt, updatedAt: doc.updatedAt, confidence: 'confirmed' });
  doc.recentContributions.push({ turnId: 'turn_1', sessionId: 'session_a', rootMessageId: 'om_a', summary: 'Topic A completed the migration', createdAt: doc.updatedAt });
  return renderTopicGroupMemoryBlock(doc, { injectMode: 'summary-and-facts', maxPromptChars: 3000 });
}

describe('topic-group memory prompt injection', () => {
  it('places memory before the opening user message', () => {
    const input = buildNewTopicCliInput('current request', 'session_x', 'codex', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { topicGroupMemoryBlock: block() });
    expect(input.content).toContain('<topic_group_memory');
    expect(input.content.indexOf('<topic_group_memory')).toBeLessThan(input.content.indexOf('<user_message>'));
    expect(input.content).toContain('以当前话题用户消息为准');
  });

  it('places memory before the opening user message for Codex, Claude and TraeX', () => {
    for (const cliId of ['codex', 'claude-code', 'traex'] as const) {
      const input = buildNewTopicCliInput('current request', 'session_x', cliId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { topicGroupMemoryBlock: block() });
      expect(input.content).toContain('<topic_group_memory');
      expect(input.content.indexOf('<topic_group_memory')).toBeLessThan(input.content.indexOf('<user_message>'));
      expect(input.content).toContain('<resources>');
      expect(input.content).toContain('Main PRD');
    }
  });

  it('injects memory into follow-up and Codex App additionalContext', () => {
    const memory = block();
    const legacy = buildFollowUpCliInput('next request', 'session_x', { cliId: 'codex', topicGroupMemoryBlock: memory });
    expect(legacy.content.indexOf('<topic_group_memory')).toBeLessThan(legacy.content.indexOf('<user_message>'));
    const app = buildFollowUpCliInput('next request', 'session_x', { cliId: 'codex-app', topicGroupMemoryBlock: memory });
    expect(Object.keys(app.codexAppInput?.additionalContext ?? {})).toContain('botmux_topic_group_memory');
  });

  it('bounds the rendered block', () => {
    const doc = createEmptyTopicGroupMemory('cli_app', 'oc_chat');
    doc.summary = 'x'.repeat(5000);
    const rendered = renderTopicGroupMemoryBlock(doc, { injectMode: 'summary', maxPromptChars: 800 });
    expect(rendered.length).toBeLessThanOrEqual(800);
    expect(rendered.endsWith('</topic_group_memory>')).toBe(true);
  });

  it('does not inject contribution-only de-duplication metadata', () => {
    const doc = createEmptyTopicGroupMemory('cli_app', 'oc_chat');
    doc.recentContributions.push({
      turnId: 'turn_1', sessionId: 'session_1', rootMessageId: 'om_root',
      summary: 'tracking only', createdAt: doc.updatedAt,
    });
    expect(renderTopicGroupMemoryBlock(doc, { injectMode: 'summary', maxPromptChars: 8_000 })).toBe('');
  });

  it('keeps engineering resources ahead of a long summary under a tight budget', () => {
    const doc = createEmptyTopicGroupMemory('cli_app', 'oc_chat');
    doc.summary = 'long summary '.repeat(500);
    doc.resources.push({
      id: 'resource_priority',
      kind: 'prd',
      title: 'Priority PRD',
      url: 'https://bytedance.larkoffice.com/docx/PriorityPrd',
      createdAt: doc.updatedAt,
      updatedAt: doc.updatedAt,
      confidence: 'confirmed',
    });
    const rendered = renderTopicGroupMemoryBlock(doc, { injectMode: 'summary', maxPromptChars: 650 });
    expect(rendered).toContain('<resources>');
    expect(rendered).toContain('Priority PRD');
    expect(rendered.indexOf('<resources>')).toBeLessThan(rendered.indexOf('<summary>'));
    expect(rendered.length).toBeLessThanOrEqual(650);
  });
});
