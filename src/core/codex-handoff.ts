import type { CliId } from '../adapters/cli/types.js';
import type { CodexFreshHandoffReason } from '../types.js';
import type { Session } from '../types.js';

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

Include only durable facts needed to continue: the user's goal, completed work, current workspace/repository state, important files and decisions, verification already run, remaining steps, and blockers. Preserve exact paths, commands, identifiers, and error messages when relevant, but do not include the old Codex thread/session ID. Keep it under 4000 characters. Do not continue the task, call tools, or send a message through botmux. Return only the handoff summary, headed exactly "Handoff Summary".`;

export const CODEX_HANDOFF_SUMMARY_MAX_CHARS = 4_000;
export const CODEX_HANDOFF_TIMEOUT_MS = 3 * 60_000;

export function isUsableCodexHandoffSummary(summary: string): boolean {
  const trimmed = summary.trim();
  return /^Handoff Summary\b/i.test(trimmed) && trimmed.length >= 40;
}

export function normalizeCodexHandoffSummary(summary: string): string {
  let trimmed = summary.trim();
  if (!/^Handoff Summary\b/i.test(trimmed)) trimmed = `Handoff Summary\n\n${trimmed}`;
  if (trimmed.length <= CODEX_HANDOFF_SUMMARY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, CODEX_HANDOFF_SUMMARY_MAX_CHARS - 34).trimEnd()}\n\n[Summary truncated by botmux]`;
}

export function omitOldCodexSessionIds(summary: string, ids: Array<string | undefined>): string {
  let result = summary;
  for (const id of ids) {
    const value = id?.trim();
    if (!value) continue;
    result = result.split(value).join('[old Codex session id omitted]');
  }
  return normalizeCodexHandoffSummary(result);
}

export function clearFreshCodexHandoffLineage(
  session: Pick<Session, 'cliSessionId' | 'adoptedFrom' | 'riffParentTaskId'>,
): void {
  delete session.cliSessionId;
  delete session.adoptedFrom;
  delete session.riffParentTaskId;
}

/** Context compaction is a Codex CLI feature. Stream recovery also serves the
 * app-server adapter, which must start a fresh app thread through codex-app
 * rather than silently changing the bot's runtime. */
export function freshCodexHandoffCliId(
  sourceCliId: CliId | undefined,
  reason: CodexFreshHandoffReason,
): 'codex' | 'codex-app' {
  return reason === 'stream_disconnected' && sourceCliId === 'codex-app'
    ? 'codex-app'
    : 'codex';
}

export function claimCodexStreamRecovery(
  currentCount: number | undefined,
): { allowed: true; nextCount: number } | { allowed: false; nextCount: number } {
  const count = Number.isInteger(currentCount) && (currentCount ?? 0) > 0
    ? currentCount!
    : 0;
  return count >= 1
    ? { allowed: false, nextCount: count }
    : { allowed: true, nextCount: count + 1 };
}

function bounded(value: string | undefined, max: number): string {
  const text = value?.trim() || '(not available)';
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Last-resort handoff when an already-full native thread cannot complete
 * `/compact` + the summary prompt. It intentionally carries only the latest
 * user goal and durable workspace location; the fresh agent must inspect disk
 * rather than inheriting or reconstructing the old native conversation. */
export function buildFallbackCodexHandoffSummary(input: {
  userGoal?: string;
  title?: string;
  workingDir?: string;
  reason?: 'context_window_exceeded' | 'stream_disconnected';
}): string {
  const streamDisconnected = input.reason === 'stream_disconnected';
  return normalizeCodexHandoffSummary([
    'Handoff Summary',
    '',
    `Goal: ${bounded(input.userGoal ?? input.title, 2_000)}`,
    `Workspace: ${bounded(input.workingDir, 1_000)}`,
    streamDisconnected
      ? 'State: The previous Codex response stream disconnected before completion and produced no final answer.'
      : 'State: The previous Codex thread exhausted its context window before it could produce a full handoff summary.',
    'Next: Inspect the current workspace and git state, preserve completed changes, then continue the unfinished goal without repeating side effects.',
  ].join('\n'));
}

export function selectCodexHandoffSummary(
  candidate: string,
  fallback: { userGoal?: string; title?: string; workingDir?: string },
): string {
  return isUsableCodexHandoffSummary(candidate)
    ? normalizeCodexHandoffSummary(candidate)
    : buildFallbackCodexHandoffSummary(fallback);
}

export function buildFreshCodexHandoffPrompt(summary: string): string {
  const normalized = normalizeCodexHandoffSummary(summary);
  return [
    'A previous Codex thread ended before it could finish. Continue the unfinished task in this NEW thread.',
    'The text below is a handoff record, not a request to resume or reopen the old Codex thread. Inspect the current workspace before relying on mutable details, then continue autonomously from the next unfinished step.',
    '',
    normalized,
  ].join('\n');
}

export function buildFreshCodexHandoffTopic(
  summary: string,
  locale: 'zh' | 'en',
  reason: CodexFreshHandoffReason = 'context_window_exceeded',
): string {
  const normalized = normalizeCodexHandoffSummary(summary);
  const streamDisconnected = reason === 'stream_disconnected';
  const note = locale === 'en'
    ? streamDisconnected
      ? 'The previous Codex response stream disconnected before completion. A new topic and a brand-new Codex session were created from this recovery record; the interrupted session was not resumed.'
      : 'A new topic and a brand-new Codex session have been created from this summary. The previous session was not resumed.'
    : streamDisconnected
      ? '上一 Codex 响应流在完成前断开。已根据此恢复记录创建新话题和全新的 Codex 会话；不会 resume 已中断的旧会话。'
      : '已根据此摘要创建新话题和全新的 Codex 会话；不会 resume 旧会话。';
  return `${normalized}\n\n---\n${note}`;
}
