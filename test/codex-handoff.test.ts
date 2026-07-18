import { describe, expect, it } from 'vitest';
import {
  buildFreshCodexHandoffPrompt,
  buildFreshCodexHandoffTopic,
  CODEX_HANDOFF_SUMMARY_PROMPT,
  shouldFreshHandoffCodex,
} from '../src/core/codex-handoff.js';

describe('Codex /compact fresh handoff', () => {
  it('intercepts only the exact Codex /compact command', () => {
    expect(shouldFreshHandoffCodex('codex', '/compact')).toBe(true);
    expect(shouldFreshHandoffCodex('codex', ' /COMPACT ')).toBe(true);
    expect(shouldFreshHandoffCodex('codex', '/compact extra')).toBe(false);
    expect(shouldFreshHandoffCodex('codex-app', '/compact')).toBe(false);
    expect(shouldFreshHandoffCodex('claude-code', '/compact')).toBe(false);
  });

  it('asks the exhausted thread for a bounded summary without continuing work', () => {
    expect(CODEX_HANDOFF_SUMMARY_PROMPT).toContain('headed exactly "Handoff Summary"');
    expect(CODEX_HANDOFF_SUMMARY_PROMPT).toContain('Do not continue the task');
    expect(CODEX_HANDOFF_SUMMARY_PROMPT).toContain('remaining steps');
    expect(CODEX_HANDOFF_SUMMARY_PROMPT).toContain('under 6000 characters');
  });

  it('labels the visible topic and fresh prompt as non-resume handoff', () => {
    const summary = 'Handoff Summary\n\nGoal: finish the migration.';
    expect(buildFreshCodexHandoffTopic(summary, 'zh')).toContain('不会 resume');
    expect(buildFreshCodexHandoffTopic(summary, 'en')).toContain('was not resumed');
    const prompt = buildFreshCodexHandoffPrompt(summary);
    expect(prompt).toContain('NEW thread');
    expect(prompt).toContain('not a request to resume');
    expect(prompt).toContain(summary);
  });
});
