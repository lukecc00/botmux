import type { CliId } from '../adapters/cli/types.js';

/**
 * Codex's native /compact keeps the same thread id.  That is useful for an
 * ordinary compaction, but it cannot recover a thread which has already hit
 * the model's hard context ceiling.  Botmux therefore treats /compact as a
 * cross-thread handoff for Codex: compact first, ask the old thread for a
 * bounded summary, then seed a brand-new thread from that summary.
 */
export function shouldFreshHandoffCodex(cliId: CliId, command: string): boolean {
  return cliId === 'codex' && command.trim().toLowerCase() === '/compact';
}

export const CODEX_HANDOFF_SUMMARY_PROMPT = `Create a Handoff Summary for a brand-new Codex thread that will continue the unfinished work.

Include only durable facts needed to continue: the user's goal, completed work, current workspace/repository state, important files and decisions, verification already run, remaining steps, and blockers. Preserve exact paths, commands, identifiers, and error messages when relevant. Keep it under 6000 characters. Do not continue the task, call tools, or send a message through botmux. Return only the handoff summary, headed exactly "Handoff Summary".`;

export function buildFreshCodexHandoffPrompt(summary: string): string {
  return [
    'A previous Codex thread reached its context limit. Continue the unfinished task in this NEW thread.',
    'The text below is a handoff record, not a request to resume or reopen the old Codex thread. Inspect the current workspace before relying on mutable details, then continue autonomously from the next unfinished step.',
    '',
    summary.trim(),
  ].join('\n');
}

export function buildFreshCodexHandoffTopic(summary: string, locale: 'zh' | 'en'): string {
  const note = locale === 'en'
    ? 'A new topic and a brand-new Codex session have been created from this summary. The context-exhausted session was not resumed.'
    : '已根据此摘要创建新话题和全新的 Codex 会话；不会 resume 已耗尽上下文的旧会话。';
  return `${summary.trim()}\n\n---\n${note}`;
}
