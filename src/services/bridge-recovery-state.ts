import { createHash } from 'node:crypto';
import type { Session } from '../types.js';

export type PendingBridgeTurn = NonNullable<Session['pendingBridgeTurns']>[number];

function deliveryKey(kind: 'progress' | 'final', nativeUuid: string): string {
  return `${kind === 'progress' ? 'p' : 'f'}:${nativeUuid}`;
}

export function stagePendingBridgeTurn(session: Session, turn: PendingBridgeTurn): boolean {
  const turns = [...(session.pendingBridgeTurns ?? [])];
  const index = turns.findIndex(candidate =>
    candidate.turnId === turn.turnId
    && candidate.dispatchAttempt === turn.dispatchAttempt,
  );
  if (index >= 0) {
    if (JSON.stringify(turns[index]) === JSON.stringify(turn)) return false;
    turns[index] = turn;
  } else {
    turns.push(turn);
  }
  session.pendingBridgeTurns = turns.slice(-32);
  return true;
}

export function completePendingBridgeTurn(
  session: Session,
  turnId: string,
  dispatchAttempt?: number,
): boolean {
  const current = session.pendingBridgeTurns ?? [];
  const next = current.filter(turn =>
    turn.turnId !== turnId || turn.dispatchAttempt !== dispatchAttempt,
  );
  if (next.length === current.length) return false;
  if (next.length > 0) session.pendingBridgeTurns = next;
  else delete session.pendingBridgeTurns;
  return true;
}

export function markPendingBridgeTurnWritten(
  session: Session,
  turnId: string,
  dispatchAttempt: number | undefined,
  writtenAt: number,
): boolean {
  const turn = session.pendingBridgeTurns?.find(candidate =>
    candidate.turnId === turnId
    && candidate.dispatchAttempt === dispatchAttempt,
  );
  if (!turn || turn.writtenAt === writtenAt) return false;
  turn.writtenAt = writtenAt;
  return true;
}

export function markPendingBridgeTurnTerminal(
  session: Session,
  turnId: string,
  dispatchAttempt: number | undefined,
  terminalAt: number = Date.now(),
): boolean {
  const turn = session.pendingBridgeTurns?.find(candidate =>
    candidate.turnId === turnId
    && candidate.dispatchAttempt === dispatchAttempt,
  );
  if (!turn || turn.terminalAt !== undefined) return false;
  turn.terminalAt = terminalAt;
  return true;
}

export function bridgeDeliveryAcknowledged(
  session: Session,
  kind: 'progress' | 'final',
  nativeUuid: string,
): boolean {
  return session.deliveredBridgeUuids?.includes(deliveryKey(kind, nativeUuid)) === true;
}

export function rememberBridgeDelivery(
  session: Session,
  kind: 'progress' | 'final',
  nativeUuid: string,
): boolean {
  const key = deliveryKey(kind, nativeUuid);
  const delivered = session.deliveredBridgeUuids ?? [];
  if (delivered.includes(key)) return false;
  session.deliveredBridgeUuids = [...delivered, key].slice(-512);
  return true;
}

/** Stable Lark provider UUID for replayed transcript finals (<= 50 chars). */
export function bridgeFinalProviderUuid(sessionId: string, nativeUuid: string): string {
  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(nativeUuid)
    .digest('hex')
    .slice(0, 40);
  return `bmxf_${digest}`;
}
