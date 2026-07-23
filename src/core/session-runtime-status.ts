import type { DaemonSession } from './types.js';
import type { StreamStatus } from '../types.js';

export type SessionRuntimeStatus = StreamStatus | 'dormant';

/** True while a bridge-backed model turn has not reached an authoritative
 * terminal edge. A terminal turn can remain persisted while its final Lark
 * delivery is retried/replayed; that is delivery recovery, not model work. */
export function hasUnterminatedBridgeTurn(ds: DaemonSession): boolean {
  return ds.session.pendingBridgeTurns?.some(turn => turn.terminalAt === undefined) === true;
}

/** Conversation replacement is daemon-owned work and can outlive the source
 * Codex worker, so worker presence alone cannot describe task liveness. */
export function hasActiveCodexHandoff(ds: DaemonSession): boolean {
  if (ds.pendingCodexFreshHandoff && ds.pendingCodexFreshHandoff.phase !== 'completed') return true;
  return !!ds.session.codexFreshHandoff && ds.session.codexFreshHandoff.phase !== 'completed';
}

export function hasActiveSessionWork(ds: DaemonSession): boolean {
  return hasActiveCodexHandoff(ds) || hasUnterminatedBridgeTurn(ds);
}

/** User-facing/runtime-policy status. Durable bridge/handoff state overrides
 * a prompt-looking idle edge because Codex may already have switched to a new
 * native conversation while the original Botmux task continues. */
export function sessionRuntimeStatus(
  ds: DaemonSession,
  observedStatus: StreamStatus | undefined = ds.lastScreenStatus,
): SessionRuntimeStatus {
  if (ds.session.queued) return 'idle';
  if (observedStatus === 'limited') return 'limited';
  if (hasActiveSessionWork(ds)) return 'working';
  if (!ds.worker || ds.worker.killed) return 'dormant';
  return observedStatus ?? 'starting';
}

export function isSessionRuntimeIdleOrLimited(ds: DaemonSession): boolean {
  const status = sessionRuntimeStatus(ds);
  return status === 'idle' || status === 'limited';
}

/** Card/screen handlers run for a live worker and accept StreamStatus only.
 * Keep a defensive starting fallback for stale-worker races. */
export function liveSessionRuntimeStatus(
  ds: DaemonSession,
  observedStatus: StreamStatus | undefined = ds.lastScreenStatus,
): StreamStatus {
  const status = sessionRuntimeStatus(ds, observedStatus);
  return status === 'dormant' ? 'starting' : status;
}
