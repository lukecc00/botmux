import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('Codex missing-final recovery wiring', () => {
  it('keeps stream-disconnect recovery as a forced fresh in-place session once', () => {
    expect(workerSource).toContain("stripAnsiForLog(currentCodexTerminalOutputTail)");
    expect(workerSource).toContain("turn.terminalEvidence ?? ''");
    expect(workerSource).toContain("terminalDiagnostic === 'stream_disconnected'");
    expect(workerSource).toContain("turn.terminalErrorCode = CODEX_MISSING_FINAL_ERROR;");
    expect(workerSource).toContain("turn.terminalErrorCode === CODEX_MISSING_FINAL_ERROR");
    expect(workerSource).toContain('inflightInputs.onTurnFailed(');
    expect(workerSource).toContain("codexMissingFinalRecoveryAttempts.set(turn.turnId, 1);");
    expect(workerSource).toContain("restartCliProcess('Codex task completed without final output', {");
    expect(workerSource).toContain('forceFresh: true,');
    expect(workerSource).toContain('resume: false,');
    expect(workerSource).toContain('cliSessionId: undefined,');
  });

  it('routes context exhaustion to daemon handoff without replaying in the old topic', () => {
    expect(workerSource).toContain("terminalDiagnostic === 'context_window_exceeded'");
    expect(workerSource).toContain('turn.terminalErrorCode = CODEX_CONTEXT_WINDOW_ERROR;');
    const marker = "turn.terminalErrorCode === CODEX_CONTEXT_WINDOW_ERROR";
    const start = workerSource.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const nextBranch = workerSource.indexOf("turn.terminalErrorCode === CODEX_MISSING_FINAL_ERROR", start);
    expect(nextBranch).toBeGreaterThan(start);
    const region = workerSource.slice(start, nextBranch);
    expect(region).toContain("type: 'codex_context_exhausted'");
    expect(region).toContain('inflightInputs.onTurnComplete()');
    expect(region).not.toContain('inflightInputs.onTurnFailed(');
    expect(region).not.toContain('restartCliProcess(');
    expect(region).not.toContain('CODEX_RECOVERY_SUFFIX');
  });

  it('closes a normal empty completion silently instead of reporting an anomaly', () => {
    expect(workerSource).toContain("turn.terminalStatus = 'completed';");
    expect(workerSource).toContain('turn.terminalErrorCode = undefined;');
  });

  it('does not classify the stale whole viewport as the current turn terminal', () => {
    const marker = 'const terminalDiagnostic = classifyCodexTerminalDiagnostic(';
    const start = workerSource.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const region = workerSource.slice(start, start + 400);
    expect(region).not.toContain('latestFilteredScreenContent');
  });

  it('freezes terminal evidence on the exact pending turn', () => {
    expect(workerSource).toContain('terminalEvidence: stripAnsiForLog(currentCodexTerminalOutputTail)');
    expect(workerSource).toContain('terminalViewportEvidence: renderer?.rawSnapshot() ?? latestFilteredScreenContent');
    expect(workerSource).toContain('codexBridgeQueue.refreshLastAmbiguousTerminalEvidence({');
    expect(workerSource).toContain('turn.terminalEvidence ??');
    expect(workerSource).toContain('turn.terminalViewportEvidence ??');
  });

  it('waits for terminal paint before classifying an ambiguous empty completion', () => {
    expect(workerSource).toContain('e.terminalErrorCode !== CODEX_MISSING_FINAL_CANDIDATE');
    expect(workerSource).toContain('CODEX_AMBIGUOUS_TERMINAL_SETTLE_MS = 750');
    expect(workerSource).toContain('codexAmbiguousTerminalTimer = setTimeout(() => {');
    expect(workerSource).toContain('idleDetector?.fireIdle();');
  });

  it('always publishes a user-visible terminal failure when recovery cannot finish', () => {
    expect(workerSource).toContain('自动切换新会话后仍未能完成');
    expect(workerSource).toContain('无法安全恢复原任务输入');
    expect(workerSource).toContain("emitTurnTerminal(turn.turnId, 'failed', turn.terminalErrorCode);");
  });

  it('does not worker-locally replay durable dispatch attempts', () => {
    expect(workerSource).toContain('item => item.dispatchAttempt === undefined,');
  });
});
