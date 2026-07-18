import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('Codex missing-final recovery wiring', () => {
  it('replays the interrupted ordinary turn into a forced fresh session once', () => {
    expect(workerSource).toContain("turn.terminalErrorCode === CODEX_MISSING_FINAL_ERROR");
    expect(workerSource).toContain('inflightInputs.onTurnFailed(');
    expect(workerSource).toContain("codexMissingFinalRecoveryAttempts.set(turn.turnId, 1);");
    expect(workerSource).toContain("restartCliProcess('Codex task completed without final output', {");
    expect(workerSource).toContain('forceFresh: true,');
    expect(workerSource).toContain('resume: false,');
    expect(workerSource).toContain('cliSessionId: undefined,');
  });

  it('always publishes a user-visible terminal failure when recovery cannot finish', () => {
    expect(workerSource).toContain('自动切换新会话后仍未能完成');
    expect(workerSource).toContain('无法安全恢复原任务输入');
    expect(workerSource).toContain("emitTurnTerminal(turn.turnId, 'failed', CODEX_MISSING_FINAL_ERROR);");
  });

  it('does not worker-locally replay durable dispatch attempts', () => {
    expect(workerSource).toContain('item => item.dispatchAttempt === undefined,');
  });
});
