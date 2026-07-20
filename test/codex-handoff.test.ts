import { describe, expect, it } from 'vitest';
import {
  buildFreshCodexHandoffPrompt,
  buildFreshCodexHandoffTopic,
  buildFallbackCodexHandoffSummary,
  claimCodexStreamRecovery,
  clearFreshCodexHandoffLineage,
  CODEX_HANDOFF_SUMMARY_MAX_CHARS,
  CODEX_HANDOFF_SUMMARY_PROMPT,
  normalizeCodexHandoffSummary,
  omitOldCodexSessionIds,
  selectCodexHandoffSummary,
  shouldFreshHandoffCodex,
  freshCodexHandoffCliId,
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
    expect(CODEX_HANDOFF_SUMMARY_PROMPT).toContain('under 4000 characters');
  });

  it('enforces the summary limit in code, not only in the prompt', () => {
    const normalized = normalizeCodexHandoffSummary(`Handoff Summary\n\n${'x'.repeat(8_000)}`);
    expect(normalized.length).toBeLessThanOrEqual(CODEX_HANDOFF_SUMMARY_MAX_CHARS);
    expect(normalized).toContain('[Summary truncated by botmux]');
  });

  it('uses a small workspace-oriented fallback for missing or invalid summaries', () => {
    const fallback = buildFallbackCodexHandoffSummary({
      userGoal: 'finish the migration',
      workingDir: '/repo',
    });
    expect(selectCodexHandoffSummary('context window exceeded', {
      userGoal: 'finish the migration', workingDir: '/repo',
    })).toBe(fallback);
    expect(fallback).toContain('Goal: finish the migration');
    expect(fallback).toContain('Workspace: /repo');
    expect(fallback.length).toBeLessThanOrEqual(CODEX_HANDOFF_SUMMARY_MAX_CHARS);
  });

  it('labels a stream-disconnect fallback and same-topic fresh session explicitly', () => {
    const fallback = buildFallbackCodexHandoffSummary({
      userGoal: 'finish the migration',
      workingDir: '/repo',
      reason: 'stream_disconnected',
    });
    expect(fallback).toContain('response stream disconnected before completion');
    expect(buildFreshCodexHandoffTopic(fallback, 'zh', 'stream_disconnected'))
      .toContain('响应流在完成前断开');
    expect(buildFreshCodexHandoffTopic(fallback, 'en', 'stream_disconnected'))
      .toContain('brand-new Codex session');
    expect(buildFreshCodexHandoffTopic(fallback, 'zh', 'stream_disconnected'))
      .toContain('当前飞书话题内');
    expect(buildFreshCodexHandoffTopic(fallback, 'en', 'stream_disconnected'))
      .toContain('current Lark topic');
  });

  it('labels the visible topic and fresh prompt as non-resume handoff', () => {
    const summary = 'Handoff Summary\n\nGoal: finish the migration.';
    expect(buildFreshCodexHandoffTopic(summary, 'zh')).toContain('当前飞书话题内');
    expect(buildFreshCodexHandoffTopic(summary, 'en')).toContain('current Lark topic');
    const prompt = buildFreshCodexHandoffPrompt(summary);
    expect(prompt).toContain('NEW thread');
    expect(prompt).toContain('not a request to resume');
    expect(prompt).toContain(summary);
  });

  it('removes old native and botmux session ids from the carried summary', () => {
    const summary = omitOldCodexSessionIds(
      'Handoff Summary\n\nOld native: old-native-id; old botmux: old-botmux-id.',
      ['old-native-id', 'old-botmux-id'],
    );
    expect(summary).not.toContain('old-native-id');
    expect(summary).not.toContain('old-botmux-id');
    expect(summary).toContain('[old Codex session id omitted]');
  });

  it('clears every old native/adopt/task lineage field on the fresh session', () => {
    const session = {
      cliSessionId: 'old-native',
      adoptedFrom: { cwd: '/repo', sessionId: 'old-adopted' },
      riffParentTaskId: 'old-remote-task',
    };
    clearFreshCodexHandoffLineage(session);
    expect(session).toEqual({});
  });

  it('preserves the Codex App surface only for app-server stream recovery', () => {
    expect(freshCodexHandoffCliId('codex-app', 'stream_disconnected')).toBe('codex-app');
    expect(freshCodexHandoffCliId('codex', 'stream_disconnected')).toBe('codex');
    expect(freshCodexHandoffCliId('codex-app', 'context_window_exceeded')).toBe('codex');
  });

  it('bounds consecutive stream recovery to one migration', () => {
    expect(claimCodexStreamRecovery(undefined)).toEqual({ allowed: true, nextCount: 1 });
    expect(claimCodexStreamRecovery(1)).toEqual({ allowed: false, nextCount: 1 });
  });
});
