import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('worker app-runner control-channel wiring', () => {
  it('uses the bounded decoder and resets it with worker turn state', () => {
    expect(workerSource).toContain('const appRunnerControlDecoder = new RunnerControlDecoder();');
    expect(workerSource).toContain('return appRunnerControlDecoder.push(');
    expect(workerSource).toContain('appRunnerControlDecoder.reset();');
    expect(workerSource).not.toContain('codexAppOscPending');
  });

  it('rejects marker identity mismatches and keeps dispatch authority worker-owned', () => {
    expect(workerSource).toContain('if (!identity.ok)');
    expect(workerSource).toContain('const authorityDispatchAttempt = replay');
    expect(workerSource).toContain(': currentBotmuxDispatchAttempt;');
    expect(workerSource).toContain('payload.dispatchAttempt !== authorityDispatchAttempt');
    expect(workerSource).toContain('const dispatchAttempt = authorityDispatchAttempt;');
    expect(workerSource).not.toContain('const dispatchAttempt = payload.dispatchAttempt');
  });

  it('routes structured app-server stream terminals through the durable handoff', () => {
    expect(workerSource).toContain("kind === 'terminal' && payload.status === 'failed'");
    expect(workerSource).toContain("payload.errorCode === 'codex_stream_disconnected'");
    expect(workerSource).toContain('beginCodexStreamDisconnectHandoff(');
  });

  it('requests pending-marker replay from a warm Codex App runner', () => {
    expect(workerSource).toContain('cliAdapter.replayPendingTurns');
    expect(workerSource).toContain('Codex App runner replay requested');
    expect(workerSource).toContain("handleCodexAppMarker(body: string, replay = false)");
    expect(workerSource).toContain("if (replay && kind !== 'thread' && !pendingTurn) return;");
  });
});
