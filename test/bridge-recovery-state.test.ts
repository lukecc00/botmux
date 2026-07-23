import { describe, expect, it } from 'vitest';
import type { Session } from '../src/types.js';
import {
  bridgeDeliveryAcknowledged,
  bridgeFinalProviderUuid,
  completePendingBridgeTurn,
  markPendingBridgeTurnWritten,
  markPendingBridgeTurnTerminal,
  rememberBridgeDelivery,
  stagePendingBridgeTurn,
} from '../src/services/bridge-recovery-state.js';

function session(): Session {
  return {
    sessionId: 'session-a', chatId: 'chat-a', rootMessageId: 'om_root',
    title: 'test', status: 'active', createdAt: new Date().toISOString(),
  } as Session;
}

describe('bridge recovery state', () => {
  it('persists, updates and completes exact in-flight turns', () => {
    const s = session();
    expect(stagePendingBridgeTurn(s, {
      turnId: 'turn-a', content: 'prompt', startedAt: 100,
    })).toBe(true);
    expect(stagePendingBridgeTurn(s, {
      turnId: 'turn-a', content: 'prompt', startedAt: 100,
    })).toBe(false);
    expect(s.pendingBridgeTurns).toHaveLength(1);
    expect(markPendingBridgeTurnWritten(s, 'turn-a', undefined, 120)).toBe(true);
    expect(s.pendingBridgeTurns?.[0]?.writtenAt).toBe(120);
    expect(markPendingBridgeTurnWritten(s, 'turn-a', undefined, 120)).toBe(false);
    expect(markPendingBridgeTurnTerminal(s, 'turn-a', undefined, 140)).toBe(true);
    expect(s.pendingBridgeTurns?.[0]?.terminalAt).toBe(140);
    expect(markPendingBridgeTurnTerminal(s, 'turn-a', undefined, 150)).toBe(false);
    expect(completePendingBridgeTurn(s, 'turn-a')).toBe(true);
    expect(s.pendingBridgeTurns).toBeUndefined();
  });

  it('bounds the provider acknowledgement ledger and scopes progress/final', () => {
    const s = session();
    expect(rememberBridgeDelivery(s, 'progress', 'native-1')).toBe(true);
    expect(bridgeDeliveryAcknowledged(s, 'progress', 'native-1')).toBe(true);
    expect(bridgeDeliveryAcknowledged(s, 'final', 'native-1')).toBe(false);
    expect(rememberBridgeDelivery(s, 'progress', 'native-1')).toBe(false);
  });

  it('derives stable bounded final provider UUIDs', () => {
    const a = bridgeFinalProviderUuid('session-a', 'native-final');
    expect(a).toBe(bridgeFinalProviderUuid('session-a', 'native-final'));
    expect(a).not.toBe(bridgeFinalProviderUuid('session-b', 'native-final'));
    expect(a.length).toBeLessThanOrEqual(50);
  });
});
