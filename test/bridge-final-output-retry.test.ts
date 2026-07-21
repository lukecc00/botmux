/**
 * P2: daemon-side retry of `final_output` on transient Lark failures.
 *
 * The worker pops each turn off its queue at emit time and never re-sends
 * the same payload, so the daemon owns retry. We verify:
 *   - transient sessionReply rejections retry up to 3 times with backoff
 *   - dedup marker is committed only after a successful send
 *   - MessageWithdrawnError aborts retries (no point), commits dedup, and
 *     closes the session
 *   - 3 consecutive failures give up and DO NOT commit the dedup marker
 *     (so any retransmit can still deliver)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const updateMessageMock = vi.fn(async () => {});
const addReactionMock = vi.fn(async () => 'reaction_id');
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...args: any[]) => updateMessageMock(...args),
  addReaction: (...args: any[]) => addReactionMock(...args),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { EventEmitter } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptVcMeetingDelivery,
  applyVcMeetingMemberProjection,
  completeVcMeetingDelivery,
  failVcMeetingDelivery,
  markVcMeetingDeliveryAmbiguous,
  markVcMeetingDeliveryDispatched,
} from '../src/services/vc-meeting-delivery-store.js';
import { listVcMeetingActions } from '../src/services/vc-meeting-action-store.js';
import { listVcMeetingListenerMessageIds } from '../src/services/vc-meeting-listener-message-store.js';

// Build a fake worker child process whose IPC `message` event we can fire
// manually, then wire it through setupWorkerHandlers via forkAdoptWorker.
// To keep this test focused on the retry pipeline (and avoid spawning a
// real fork), we exercise the case branch by invoking the registered
// listener directly.

function makeDs(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  return {
    session: {
      sessionId: 'sid-final-out',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker: fakeWorker,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
    adoptedFrom: {
      tmuxTarget: '0:1.0',
      originalCliPid: 1234,
      sessionId: 'claude-session-xyz',
      cliId: 'claude-code' as const,
      cwd: '/tmp',
    },
  };
}

function makeHermesDs(): DaemonSession {
  const ds = makeDs();
  ds.session.cliId = 'hermes';
  return ds;
}

function finalOutputMsg(): Extract<WorkerToDaemon, { type: 'final_output' }> {
  return { type: 'final_output', content: 'final answer', lastUuid: 'uuid-1', turnId: 'turn-1' };
}

function seedReceiverReceipt(responseMode: 'silent' | 'listener_thread'): void {
  const memberKey = {
    listenerAppId: 'listener-app', meetingId: 'meeting-1', memberId: 'member-1', memberEpoch: 1,
  };
  expect(applyVcMeetingMemberProjection('/tmp/test-sessions', {
    ...memberKey,
    ownerBootId: 'owner-boot', ownerEpoch: 1, agentAppId: 'app_test', role: 'minutes',
    membershipGeneration: 1, status: 'active', responseMode, joinedAtIngestSeq: 0,
    capabilities: ['meeting.read', 'listener.output.request'], ownedSinks: [], sinkOwnerGeneration: 1,
    receiverSessionId: 'sid-final-out', outputChatId: 'oc_chat',
  })).toMatchObject({ ok: true });
  expect(acceptVcMeetingDelivery('/tmp/test-sessions', {
    ...memberKey,
    ownerBootId: 'owner-boot', ownerEpoch: 1, membershipGeneration: 1,
    deliveryKey: 'delivery-stable-key', inputHash: 'input-hash', fromSeq: 1, toSeq: 1,
    responseMode, receiverBootId: 'receiver-boot',
  })).toMatchObject({ kind: 'accepted' });
  expect(markVcMeetingDeliveryDispatched('/tmp/test-sessions', {
    ...memberKey, deliveryKey: 'delivery-stable-key',
  }, { receiverBootId: 'receiver-boot', workerGeneration: 1 })).toMatchObject({
    ok: true,
    receipt: { status: 'dispatched' },
  });
}

function seedSilentReceiverReceipt(): void {
  seedReceiverReceipt('silent');
}

const SCOPED_DEDUPE_KEY = 'sid-final-out:uuid-1';

describe('Bridge final_output delivery (P2 retry)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    rmSync('/tmp/test-sessions', { recursive: true, force: true });
    mkdirSync('/tmp/test-sessions', { recursive: true });
  });

  afterEach(() => {
    rmSync('/tmp/test-sessions', { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('commits dedup uuid only after a successful sessionReply', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    // Drive the case 'final_output' by invoking the registered handler.
    // setupWorkerHandlers attaches handler when a worker is forked, but we
    // bypass that: invoke the callback by emitting a message to the
    // EventEmitter that the live `worker.on('message')` registers. The
    // simplest path is to fork the worker via forkAdoptWorker — but that
    // spawns a real process. Instead we rely on the case branch's
    // self-contained behavior by importing deliverFinalOutput indirectly
    // via firing the IPC 'message' event after attaching a listener that
    // mirrors the case branch.
    //
    // Implementation detail: setupWorkerHandlers is internal; we exercise
    // it by directly calling the IPC entry. Since deliverFinalOutput is
    // file-private, we reach it through the public IPC dispatch.

    const ds = makeDs();
    // Hand-wired dispatcher that mirrors the relevant case branch in
    // setupWorkerHandlers. Keeping it here keeps the test independent of
    // unrelated card/state plumbing.
    const dispatcher = async (msg: WorkerToDaemon) => {
      if (msg.type !== 'final_output') return;
      if (!msg.content || !msg.content.trim()) return;
      if (msg.lastUuid && ds.lastBridgeEmittedUuid === `${msg.sessionId ?? ds.session.sessionId}:${msg.lastUuid}`) return;
      // Direct call to the public path:
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, msg, 'tag', 0);
    };

    await dispatcher(finalOutputMsg());
    // First attempt is delayed 0ms; flush microtasks + timers
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][4]).toBe('turn-1');
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('lets a daemon handoff consume final_output without posting it normally', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    const onFinalOutput = vi.fn(async () => true);
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onFinalOutput,
    });

    const ds = makeDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(onFinalOutput).toHaveBeenCalledTimes(1);
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('drops final_output whose worker sessionId does not match the daemon session', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: 'sid-other-worker',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('records Hermes source binding and allows matching sourceHermesSessionId', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A',
    });
    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-A']));
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('resets Hermes source authorization for a replacement worker and ignores stale bindings', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    const oldWorker = ds.worker as any;
    __testOnly_setupWorkerHandlers(ds, oldWorker);
    oldWorker.emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A',
    });
    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-A']));

    const replacementWorker = new EventEmitter() as any;
    replacementWorker.killed = false;
    replacementWorker.send = vi.fn();
    replacementWorker.kill = vi.fn();
    replacementWorker.pid = 100000;
    __testOnly_setupWorkerHandlers(ds, replacementWorker);
    ds.worker = replacementWorker;

    expect(ds.hermesBridgeSourceSessionIds).toBeUndefined();

    replacementWorker.emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).not.toHaveBeenCalled();

    oldWorker.emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A-late',
    });
    expect(ds.hermesBridgeSourceSessionIds).toBeUndefined();

    replacementWorker.emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-C',
    });
    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-C']));
  });

  it('keeps old and rebound Hermes sources valid when one drain emits both turns', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // The worker was already bound to A. During one later drain it discovers
    // C's marker and sends that rebind before emitReadyCodexTurns forwards the
    // completed A turn followed by C's turn.
    (ds.worker as any).emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-A',
    });
    (ds.worker as any).emit('message', {
      type: 'bridge_source_session',
      bridge: 'hermes',
      sourceSessionId: 'hermes-C',
    });
    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
      content: 'answer from A',
      lastUuid: 'uuid-A',
      turnId: 'turn-A',
    });
    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-C',
      content: 'answer from C',
      lastUuid: 'uuid-C',
      turnId: 'turn-C',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(ds.hermesBridgeSourceSessionIds).toEqual(new Set(['hermes-A', 'hermes-C']));
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls[0][1]).toContain('answer from A');
    expect(sessionReply.mock.calls[1][1]).toContain('answer from C');
    expect(sessionReply.mock.calls.map(call => call[4])).toEqual(['turn-A', 'turn-C']);
  });

  it('drops Hermes final_output whose sourceHermesSessionId does not match the bound source', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    ds.hermesBridgeSourceSessionIds = new Set(['hermes-A']);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-B',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('drops Hermes final_output with sourceHermesSessionId before daemon has a binding', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
      sourceHermesSessionId: 'hermes-A',
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('drops Hermes final_output without sourceHermesSessionId after a source is bound', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeHermesDs();
    ds.hermesBridgeSourceSessionIds = new Set(['hermes-A']);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it('does not apply the Hermes source guard after the session switches to another CLI', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.cliId = 'codex';
    ds.hermesBridgeSourceSessionIds = new Set(['hermes-A']);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      ...finalOutputMsg(),
      sessionId: ds.session.sessionId,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('does not address daemon final-output footers to a known bot owner', async () => {
    writeFileSync(
      join('/tmp/test-sessions', 'bot-openids-app_test.json'),
      JSON.stringify({ Claude: 'ou_foreign_bot' }),
    );

    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_foreign_bot';
    ds.ownerOpenId = 'ou_foreign_bot';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('[botmux](');
    expect(cardJson).not.toContain('<at id=ou_foreign_bot></at>');
  });

  it('addresses Mira daemon fallback output back to the bot dispatcher', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.cliId = 'mira';
    ds.session.ownerOpenId = undefined;
    ds.ownerOpenId = undefined;
    ds.session.creatorOpenId = 'ou_dispatcher_bot';
    ds.session.quoteTargetSenderIsBot = true;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('<at id=ou_dispatcher_bot></at>');
  });

  it('addresses Mira fallback output to a known-bot owner (/repo-primed dispatch)', async () => {
    // `botmux dispatch --repo` primes the thread with "@bot /repo <path>",
    // which records the dispatching bot as ownerOpenId (daemon /repo
    // session-create path) instead of nulling it like @-mention auto-create.
    writeFileSync(
      join('/tmp/test-sessions', 'bot-openids-app_test.json'),
      JSON.stringify({ Orchestrator: 'ou_orch_bot' }),
    );

    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.cliId = 'mira';
    ds.session.ownerOpenId = 'ou_orch_bot';
    ds.ownerOpenId = 'ou_orch_bot';
    ds.session.creatorOpenId = 'ou_orch_bot';
    ds.session.quoteTargetSenderIsBot = true;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain('<at id=ou_orch_bot></at>');
  });

  it('puts a real body mention on daemon final output for a human owner', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_human';
    ds.ownerOpenId = 'ou_human';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    const elements = JSON.parse(cardJson).body.elements;
    expect(elements[0].content).toBe('<at id=ou_human></at>');
    expect(elements[elements.length - 1].content).not.toContain('<at id=ou_human></at>');
  });

  it('mentions the exact turn caller instead of the topic owner', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.ownerOpenId = 'ou_owner';
    ds.session.lastCallerOpenId = 'ou_later_caller';
    ds.session.turnCallers = {
      'turn-1': { openId: 'ou_exact_caller', updatedAt: new Date().toISOString() },
    };

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    const elements = JSON.parse(sessionReply.mock.calls[0][1] as string).body.elements;
    expect(elements[0].content).toBe('<at id=ou_exact_caller></at>');
    expect(sessionReply.mock.calls[0][1]).not.toContain('ou_owner');
    expect(sessionReply.mock.calls[0][1]).not.toContain('ou_later_caller');
  });

  it('uses probe-free lexical link repair for sandboxed bridge fallback output', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.sandbox = true;
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-${Date.now()}.md`;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: `[file](${missing})`,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it('preserves a real home-shaped relative link in a non-isolated bridge fallback', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const cwd = mkdtempSync(join(tmpdir(), 'botmux-bridge-relative-'));
    const relativeHome = homedir().replace(/^\/+|\/+$/g, '');
    const relativeFile = `${relativeHome}/project/a.md`;
    mkdirSync(join(cwd, relativeHome, 'project'), { recursive: true });
    writeFileSync(join(cwd, relativeFile), 'relative');
    try {
      const ds = makeDs();
      ds.workingDir = cwd;
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, {
        ...finalOutputMsg(),
        content: `[file](${relativeFile})`,
      }, 'tag', 0);

      await vi.advanceTimersByTimeAsync(10);

      const cardJson = sessionReply.mock.calls[0][1] as string;
      expect(cardJson).toContain(`[file](${relativeFile})`);
      expect(cardJson).not.toContain(`[file](/${relativeFile})`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses probe-free lexical link repair for read-isolated bridge fallback output', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.initConfig = { readIsolation: true } as any;
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-read-iso-${Date.now()}.md`;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: `[file](${missing})`,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it.each([
    ['persisted session backend', (ds: DaemonSession) => { ds.session.backendType = 'riff'; }],
    ['reconciled live backend', (ds: DaemonSession) => {
      ds.session.backendType = 'tmux';
      ds.initConfig = { backendType: 'riff' } as any;
    }],
  ])('uses probe-free lexical link repair for Riff via %s', async (_source, configure) => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    configure(ds);
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-riff-${Date.now()}.md`;

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      content: `[file](${missing})`,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it('uses lexical link repair when sandboxing is forced globally', async () => {
    const previous = process.env.BOTMUX_SANDBOX;
    process.env.BOTMUX_SANDBOX = '1';
    try {
      const sessionReply = vi.fn(async () => 'om_reply');
      initWorkerPool({
        sessionReply,
        getSessionWorkingDir: () => '/tmp',
        getActiveCount: () => 1,
        closeSession: vi.fn(),
      });

      const ds = makeDs();
      const home = homedir().replace(/\/+$/, '');
      const relativeHome = home.replace(/^\/+/, '');
      const missing = `${relativeHome}/botmux-definitely-missing-global-sandbox-${Date.now()}.md`;

      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, {
        ...finalOutputMsg(),
        content: `[file](${missing})`,
      }, 'tag', 0);

      await vi.advanceTimersByTimeAsync(10);

      const cardJson = sessionReply.mock.calls[0][1] as string;
      expect(cardJson).toContain(`[file](/${missing})`);
    } finally {
      if (previous === undefined) delete process.env.BOTMUX_SANDBOX;
      else process.env.BOTMUX_SANDBOX = previous;
    }
  });

  it('uses probe-free lexical link repair for adopt preamble cards', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.sandbox = true;
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const missing = `${relativeHome}/botmux-definitely-missing-adopt-${Date.now()}.md`;

    (ds.worker as any).emit('message', {
      type: 'adopt_preamble',
      userText: 'show file',
      assistantText: `[file](${missing})`,
      turnId: 'turn-adopt',
    });
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).toContain(`[file](/${missing})`);
  });

  it('always delivers the answer as a fresh message (never PATCHes a card in place)', async () => {
    // The placeholder pending-card + its PATCH delivery were removed entirely
    // (message.patch is silent — no Feishu notification/unread). The bridge
    // final-output now unconditionally goes out as a brand-new reply.
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });

    const ds = makeDs();
    ds.session.quoteTargetId = 'om_user';

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(updateMessageMock).not.toHaveBeenCalled();
    // Turn reactions are driven off message acceptance (noteTurnReceived) and
    // the idle edge (finishTurnReactions), not the bridge final-output path.
    expect(addReactionMock).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('locks explicit VC IM fallback output and replies to its exact Lark message with one UUID', async () => {
    const sessionReply = vi.fn(async () => 'om_vc_fallback');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im',
      memberId: 'member-im', memberEpoch: 1,
    };
    const origin = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im', memberId: 'member-im',
      memberEpoch: 1, agentAppId: 'app_test', ownerBootId: 'owner-boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_human_a',
      replyTargetSenderOpenId: 'ou_human_a',
    };
    expect(applyVcMeetingMemberProjection('/tmp/test-sessions', {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
      memberId: origin.memberId,
      memberEpoch: origin.memberEpoch,
      agentAppId: origin.agentAppId,
      ownerBootId: origin.ownerBootId,
      ownerEpoch: origin.ownerEpoch,
      role: 'minutes',
      membershipGeneration: origin.membershipGeneration,
      status: 'active',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
      ownedSinks: [],
      sinkOwnerGeneration: origin.sinkOwnerGeneration,
      joinedAtIngestSeq: 0,
      receiverSessionId: origin.receiverSessionId,
      outputChatId: ds.chatId,
    })).toMatchObject({ ok: true });
    ds.session.vcMeetingImTurnOrigins = { om_human_a: origin };
    const msg = {
      ...finalOutputMsg(),
      content: 'safe body <at id="ou_injected">Injected</at>',
      turnId: 'om_human_a',
      lastUuid: 'bridge-a',
    };
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;

    __testOnly_deliverFinalOutput(ds, msg, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][4]).toBe('om_human_a');
    expect(sessionReply.mock.calls[0][5]).toMatchObject({
      quoteMessageId: 'om_human_a',
      uuid: expect.stringMatching(/^vcp_[0-9a-f]+$/),
      sourceSessionId: ds.session.sessionId,
      suppressHook: true,
    });
    const cardJson = sessionReply.mock.calls[0][1] as string;
    expect(cardJson).not.toContain('ou_human_a');
    expect(cardJson).not.toContain('<at');
    expect(cardJson).toContain('＜at');
    const providerUuid = sessionReply.mock.calls[0][5].uuid;
    expect(listVcMeetingListenerMessageIds('/tmp/test-sessions', {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
      targetChatId: ds.chatId,
    })).toEqual(['om_vc_fallback']);

    // A daemon/worker replay sees the terminal ledger and performs no second
    // provider call. A changed replay is also suppressed: first output wins.
    __testOnly_deliverFinalOutput(ds, { ...msg, lastUuid: 'bridge-replay' }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);

    __testOnly_deliverFinalOutput(ds, {
      ...msg,
      content: 'changed fallback answer',
      lastUuid: 'bridge-changed',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(providerUuid).toBeTruthy();
  });

  it('blocks the plain fallback when VC IM authority expires during a withdrawn quote request', async () => {
    let plainFallbackCalls = 0;
    const sessionReply = vi.fn(async (...args: any[]) => {
      const opts = args[5] as {
        beforeQuoteFallback?: () => void | Promise<void>;
      } | undefined;
      // Model the exact daemon sequence: the quote RPC was already in flight,
      // then the member was removed before Lark answered "withdrawn".
      expect(applyVcMeetingMemberProjection('/tmp/test-sessions', {
        listenerAppId: 'listener-app', meetingId: 'meeting-im-race',
        memberId: 'member-im-race', memberEpoch: 1,
        agentAppId: 'app_test', ownerBootId: 'owner-boot', ownerEpoch: 1,
        role: 'minutes', membershipGeneration: 2, status: 'removed',
        responseMode: 'silent', capabilities: ['meeting.read'], ownedSinks: [],
        sinkOwnerGeneration: 1, joinedAtIngestSeq: 0,
        receiverSessionId: 'sid-final-out', outputChatId: 'oc_chat',
      })).toMatchObject({ ok: true });
      await opts?.beforeQuoteFallback?.();
      plainFallbackCalls += 1;
      return 'om_forbidden_fallback';
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im-race',
      memberId: 'member-im-race', memberEpoch: 1,
    };
    const origin = {
      listenerAppId: 'listener-app', meetingId: 'meeting-im-race',
      memberId: 'member-im-race', memberEpoch: 1,
      agentAppId: 'app_test', ownerBootId: 'owner-boot', ownerEpoch: 1,
      membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: ds.session.sessionId, larkMessageId: 'om_human_race',
    };
    expect(applyVcMeetingMemberProjection('/tmp/test-sessions', {
      ...origin,
      role: 'minutes', status: 'active', responseMode: 'silent',
      capabilities: ['meeting.read'], ownedSinks: [], joinedAtIngestSeq: 0,
      outputChatId: ds.chatId,
    })).toMatchObject({ ok: true });
    ds.session.vcMeetingImTurnOrigins = { om_human_race: origin };

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      turnId: 'om_human_race',
      lastUuid: 'bridge-race',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(plainFallbackCalls).toBe(0);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    const actions = listVcMeetingActions('/tmp/test-sessions', {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: 'attempting', attemptCount: 1 });
    expect(actions[0]).not.toHaveProperty('externalRefs.messageId');
  });

  it('indexes a successful ordinary meeting-delivery fallback output', async () => {
    const sessionReply = vi.fn(async () => 'om_meeting_fallback');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    }, 'tag', 0);

    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][5]).toMatchObject({
      uuid: expect.stringMatching(/^vcp_[0-9a-f]+$/),
      sourceSessionId: ds.session.sessionId,
      suppressHook: true,
    });
    expect(listVcMeetingListenerMessageIds('/tmp/test-sessions', {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      targetChatId: ds.chatId,
    })).toEqual(['om_meeting_fallback']);
  });

  it('reuses one provider UUID when a listener reply is accepted before crash reconciliation', async () => {
    const providerMessages = new Map<string, string>();
    let crashAfterFirstAccept = true;
    const sessionReply = vi.fn(async (...args: any[]) => {
      const uuid = args[5]?.uuid as string;
      expect(uuid).toMatch(/^vcp_[0-9a-f]+$/);
      const messageId = providerMessages.get(uuid) ?? 'om_provider_once';
      providerMessages.set(uuid, messageId);
      if (crashAfterFirstAccept) {
        crashAfterFirstAccept = false;
        throw new Error('simulated daemon crash after provider accepted UUID');
      }
      return messageId;
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    const first = {
      ...finalOutputMsg(),
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
      lastUuid: 'bridge-attempt-1',
    };
    __testOnly_deliverFinalOutput(ds, first, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);

    const deliveryKey = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
      deliveryKey: 'delivery-stable-key',
    };
    expect(markVcMeetingDeliveryAmbiguous('/tmp/test-sessions', deliveryKey, {
      workerGeneration: 1,
      dispatchAttempt: 1,
    })).toMatchObject({ ok: true, receipt: { status: 'ambiguous' } });
    expect(markVcMeetingDeliveryDispatched('/tmp/test-sessions', deliveryKey, {
      receiverBootId: 'receiver-boot-2',
      workerGeneration: 2,
    })).toMatchObject({ ok: true, receipt: { dispatchAttempt: 2 } });

    __testOnly_deliverFinalOutput(ds, {
      ...first,
      content: 'changed replay answer must not create another effect',
      dispatchAttempt: 2,
      lastUuid: 'bridge-attempt-2',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledTimes(2);
    const firstUuid = sessionReply.mock.calls[0][5].uuid;
    expect(sessionReply.mock.calls[1][5].uuid).toBe(firstUuid);
    expect(sessionReply.mock.calls[0][5]).toMatchObject({ suppressHook: true });
    expect(sessionReply.mock.calls[1][5]).toMatchObject({ suppressHook: true });
    expect(providerMessages).toEqual(new Map([[firstUuid, 'om_provider_once']]));
    expect(listVcMeetingActions('/tmp/test-sessions', {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
    })).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        providerKey: firstUuid,
        externalRefs: { messageId: 'om_provider_once' },
      }),
    ]);
  });

  it('does not emit a delayed final output after the delivery failed terminally', async () => {
    const sessionReply = vi.fn(async () => 'om_forbidden_output');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
    };
    seedReceiverReceipt('listener_thread');
    expect(failVcMeetingDelivery('/tmp/test-sessions', {
      listenerAppId: 'listener-app', meetingId: 'meeting-1',
      memberId: 'member-1', memberEpoch: 1,
      deliveryKey: 'delivery-stable-key',
    }, {
      kind: 'terminal',
      workerGeneration: 1,
      dispatchAttempt: 1,
      errorCode: 'turn_cancelled',
      pauseStream: true,
    })).toMatchObject({ ok: true, receipt: { status: 'failed_terminal' } });

    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, {
      ...finalOutputMsg(),
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(listVcMeetingListenerMessageIds('/tmp/test-sessions', {
      listenerAppId: 'listener-app', meetingId: 'meeting-1', targetChatId: ds.chatId,
    })).toEqual([]);
  });

  it('retries on transient failure and commits after success', async () => {
    const sessionReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValueOnce('om_reply');
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    // Attempt 1 (delay 0)
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();

    // Attempt 2 (delay 5000)
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();

    // Attempt 3 (delay 15000)
    await vi.advanceTimersByTimeAsync(15000);
    expect(sessionReply).toHaveBeenCalledTimes(3);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
  });

  it('gives up after 3 attempts and does NOT commit dedup', async () => {
    const sessionReply = vi.fn().mockRejectedValue(new Error('persistent'));
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(15000);

    expect(sessionReply).toHaveBeenCalledTimes(3);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('MessageWithdrawnError aborts retries, commits dedup, and closes session', async () => {
    const sessionReply = vi.fn().mockRejectedValue(new MessageWithdrawnError('om_root'));
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(0);

    // Single attempt, no further retries
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe(SCOPED_DEDUPE_KEY);
    expect(closeSession).toHaveBeenCalledWith(ds);
  });

  it('aborts pending retry if the session was closed in the meantime', async () => {
    const sessionReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockResolvedValueOnce('om_reply');  // would succeed if a 2nd attempt fired
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    // Attempt 1 fails
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionReply).toHaveBeenCalledTimes(1);

    // User closes the session before the 5s retry fires
    ds.session.status = 'closed' as any;

    // Backoff fires — must NOT call sessionReply again
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });
});

describe('Worker turn_terminal routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes a matching terminal receipt independently of final_output', async () => {
    const ds = makeDs();
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    const terminal: Extract<WorkerToDaemon, { type: 'turn_terminal' }> = {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'delivery-stable-key',
      status: 'completed',
    };
    (ds.worker as any).emit('message', terminal);
    await Promise.resolve();

    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(onTurnTerminal).toHaveBeenCalledWith(ds, terminal, { workerGeneration: 1 });
  });

  it('sends only the core final reply card, never terminal snapshots or an idle warning', async () => {
    vi.useFakeTimers();
    const ds = makeDs();
    ds.workerPort = 12345;
    ds.streamCardId = 'om_existing_stream';
    ds.suppressRecoveryCard = true;
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      type: 'screen_update',
      content: '• Ran botmux skill show botmux-workflow\n• I need to confirm the workflow',
      status: 'working',
      turnId: 'turn-workflow-confirm',
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    (ds.worker as any).emit('message', {
      type: 'screen_update',
      content: '已在飞书中询问是否启用 Workflow。',
      status: 'idle',
      turnId: 'turn-workflow-confirm',
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessionReply).not.toHaveBeenCalled();

    (ds.worker as any).emit('message', {
      type: 'final_output',
      sessionId: ds.session.sessionId,
      content: '这个需求适合拆成一个 Workflow。要我按 Workflow 自动跑完吗？',
      lastUuid: 'assistant-workflow-confirm',
      turnId: 'turn-workflow-confirm',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][2]).toBe('interactive');
    expect(sessionReply.mock.calls[0][4]).toBe('turn-workflow-confirm');
    expect(sessionReply.mock.calls[0][1]).toContain('这个需求适合拆成一个 Workflow');
    expect(sessionReply.mock.calls[0][1]).not.toContain('Ran botmux skill show');
    expect(sessionReply.mock.calls[0][1]).not.toContain('I need to confirm');
    expect(sessionReply.mock.calls[0][1]).not.toContain('异常结束');
    vi.useRealTimers();
  });

  it('forwards only structured progress as a Markdown card and dedupes its transcript uuid', async () => {
    vi.useFakeTimers();
    const ds = makeDs();
    ds.workerPort = 12345;
    ds.streamCardId = 'om_existing_stream';
    const sessionReply = vi.fn(async () => 'om_progress');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'screen_update',
      content: '• Ran pnpm build\n└ noisy terminal output\n• internal reasoning',
      status: 'working',
      turnId: 'turn-progress',
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessionReply).not.toHaveBeenCalled();

    const progress = {
      type: 'progress_output',
      sessionId: ds.session.sessionId,
      content: '修复和边界测试都已完成，现在重启并确认 daemon。',
      uuid: 'rollout.jsonl:1234',
      turnId: 'turn-progress',
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>;
    (ds.worker as any).emit('message', progress);
    (ds.worker as any).emit('message', progress);
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][2]).toBe('interactive');
    expect(sessionReply.mock.calls[0][4]).toBe('turn-progress');
    expect(sessionReply.mock.calls[0][1]).toContain('修复和边界测试都已完成');
    expect(sessionReply.mock.calls[0][1]).not.toContain('Ran pnpm build');
    expect(sessionReply.mock.calls[0][1]).not.toContain('internal reasoning');
    vi.useRealTimers();
  });

  it('keeps tool-separated commentary in FIFO and retries past the foreground budget', async () => {
    vi.useFakeTimers();
    const ds = makeDs();
    const deliveredBodies: string[] = [];
    let calls = 0;
    const sessionReply = vi.fn(async (_rootId: string, body: string) => {
      calls += 1;
      // Card 1 sees a longer provider outage than the old three-attempt
      // budget. Card 2 must not overtake it while the FIFO head is retrying.
      if (calls <= 3) throw new Error('temporary Lark outage');
      deliveredBodies.push(body);
      return `om_progress_${calls}`;
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'progress_output',
      sessionId: ds.session.sessionId,
      content: '已核对原生 XML 和 Holder：首轮明确 Bug 已定位。',
      uuid: 'commentary-before-tool',
      turnId: 'turn-layout-build',
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>);
    (ds.worker as any).emit('message', {
      type: 'progress_output',
      sessionId: ds.session.sessionId,
      content: '已完成 KMP 首轮代码修复并开始 RemoteX 标准构建。',
      uuid: 'commentary-after-tool',
      turnId: 'turn-layout-build',
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(sessionReply).toHaveBeenCalledTimes(3);
    expect(deliveredBodies).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliveredBodies).toHaveLength(2);
    expect(deliveredBodies[0]).toContain('已核对原生 XML 和 Holder');
    expect(deliveredBodies[1]).toContain('已完成 KMP 首轮代码修复并开始 RemoteX');
    expect(sessionReply.mock.calls.map(call => call[4])).toEqual([
      'turn-layout-build',
      'turn-layout-build',
      'turn-layout-build',
      'turn-layout-build',
      'turn-layout-build',
    ]);
    const providerUuids = sessionReply.mock.calls.map(call => call[5]?.uuid);
    expect(new Set(providerUuids.slice(0, 4)).size).toBe(1);
    expect(providerUuids[4]).not.toBe(providerUuids[3]);
    vi.useRealTimers();
  });

  it('waits for earlier commentary before forwarding the final answer', async () => {
    vi.useFakeTimers();
    const ds = makeDs();
    const deliveryOrder: string[] = [];
    let progressAttempts = 0;
    const sessionReply = vi.fn(async (_rootId: string, body: string) => {
      if (body.includes('构建开始')) {
        progressAttempts += 1;
        if (progressAttempts === 1) throw new Error('progress send failed once');
        deliveryOrder.push('progress');
      } else if (body.includes('最终完成')) {
        deliveryOrder.push('final');
      }
      return 'om_reply';
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'progress_output', sessionId: ds.session.sessionId,
      content: '构建开始', uuid: 'progress-before-final', turnId: 'turn-final-order',
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>);
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '最终完成', lastUuid: 'final-after-progress', turnId: 'turn-final-order',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    await vi.advanceTimersByTimeAsync(0);
    expect(deliveryOrder).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deliveryOrder).toEqual(['progress', 'final']);
    vi.useRealTimers();
  });

  it('drops permanently rejected commentary and still forwards the final answer', async () => {
    vi.useFakeTimers();
    const ds = makeDs();
    const deliveryOrder: string[] = [];
    const sessionReply = vi.fn(async (_rootId: string, body: string) => {
      if (body.includes('坏进度')) {
        throw Object.assign(new Error('Request failed with status code 400'), {
          response: { status: 400, data: { code: 230099, msg: 'invalid card' } },
        });
      }
      if (body.includes('最终仍需送达')) deliveryOrder.push('final');
      return 'om_reply';
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'progress_output', sessionId: ds.session.sessionId,
      content: '坏进度', uuid: 'permanent-progress-failure', turnId: 'turn-permanent-progress',
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>);
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '最终仍需送达', lastUuid: 'final-after-permanent-progress', turnId: 'turn-permanent-progress',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    await vi.advanceTimersByTimeAsync(0);
    expect(deliveryOrder).toEqual(['final']);
    expect(sessionReply).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('keeps retrying Lark rate limits even when the SDK wraps them in HTTP 400', async () => {
    vi.useFakeTimers();
    const ds = makeDs();
    let attempts = 0;
    const sessionReply = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('Request failed with status code 400'), {
          response: { status: 400, data: { code: 99991400, msg: 'request trigger frequency limit' } },
        });
      }
      return 'om_reply';
    });
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      type: 'progress_output', sessionId: ds.session.sessionId,
      content: '限流后重试', uuid: 'rate-limited-progress', turnId: 'turn-rate-limit',
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>);

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it('does not make one turn final wait for commentary that arrived afterward', async () => {
    vi.useFakeTimers();
    const ds = makeDs();
    const deliveryOrder: string[] = [];
    let releaseLaterProgress!: () => void;
    const laterProgressGate = new Promise<void>(resolve => { releaseLaterProgress = resolve; });
    const sessionReply = vi.fn(async (_rootId: string, body: string) => {
      if (body.includes('下一轮过程')) {
        await laterProgressGate;
        deliveryOrder.push('later-progress');
      } else if (body.includes('上一轮最终')) {
        deliveryOrder.push('final');
      }
      return 'om_reply';
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '上一轮最终', lastUuid: 'final-turn-one', turnId: 'turn-one',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    (ds.worker as any).emit('message', {
      type: 'progress_output', sessionId: ds.session.sessionId,
      content: '下一轮过程', uuid: 'progress-turn-two', turnId: 'turn-two',
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>);

    await vi.advanceTimersByTimeAsync(0);
    expect(deliveryOrder).toEqual(['final']);
    releaseLaterProgress();
    await vi.advanceTimersByTimeAsync(0);
    expect(deliveryOrder).toEqual(['final', 'later-progress']);
    vi.useRealTimers();
  });

  it('does not retry commentary or release its waiting final after close begins', async () => {
    vi.useFakeTimers();
    const ds = makeDs();
    let calls = 0;
    const sessionReply = vi.fn(async () => {
      calls += 1;
      throw new Error('temporary Lark outage');
    });
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'progress_output', sessionId: ds.session.sessionId,
      content: '关闭前过程', uuid: 'progress-before-close', turnId: 'turn-close',
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>);
    (ds.worker as any).emit('message', {
      type: 'final_output', sessionId: ds.session.sessionId,
      content: '关闭后不得发送的 final', lastUuid: 'final-before-close', turnId: 'turn-close',
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    ds.progressDeliveryClosed = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
    vi.useRealTimers();
  });

  it('drops progress emitted by a replaced worker generation', async () => {
    vi.useFakeTimers();
    const ds = makeDs();
    const oldWorker = ds.worker as any;
    const sessionReply = vi.fn(async () => 'om_progress');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, oldWorker);

    const replacementWorker = new EventEmitter() as any;
    replacementWorker.killed = false;
    replacementWorker.send = vi.fn();
    replacementWorker.kill = vi.fn();
    replacementWorker.pid = 100001;
    __testOnly_setupWorkerHandlers(ds, replacementWorker);
    ds.worker = replacementWorker;

    oldWorker.emit('message', {
      type: 'progress_output', sessionId: ds.session.sessionId,
      content: 'stale progress', uuid: 'stale-progress', turnId: 'turn-stale',
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessionReply).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('drops structured progress from a mismatched worker session', async () => {
    vi.useFakeTimers();
    const ds = makeDs();
    const sessionReply = vi.fn(async () => 'om_progress');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      type: 'progress_output', sessionId: 'another-session', content: 'must not leak',
      uuid: 'foreign:1', turnId: 'turn-progress',
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sessionReply).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('captures silent fallback output and keeps the bounded legacy marker after terminal', async () => {
    const ds = makeDs();
    ds.suppressedFinalOutputTurns = new Map([['delivery-stable-key', 1]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'final_output',
      sessionId: ds.session.sessionId,
      content: 'analysis that must stay silent',
      lastUuid: 'assistant-uuid',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.suppressedFinalOutputTurns.has('delivery-stable-key')).toBe(true);

    (ds.worker as any).emit('message', {
      type: 'turn_terminal',
      sessionId: ds.session.sessionId,
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
      status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();

    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(ds.suppressedFinalOutputTurns.has('delivery-stable-key')).toBe(true);
  });

  it('keeps a newer silent retry armed when stale output and terminal arrive first', async () => {
    const ds = makeDs();
    ds.suppressedFinalOutputTurns = new Map([['delivery-stable-key', 2]]);
    const sessionReply = vi.fn(async () => 'om_reply');
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    const emitFinal = (dispatchAttempt: number, content: string) => {
      (ds.worker as any).emit('message', {
        type: 'final_output',
        sessionId: ds.session.sessionId,
        content,
        lastUuid: `assistant-uuid-${dispatchAttempt}`,
        turnId: 'delivery-stable-key',
        dispatchAttempt,
      } satisfies Extract<WorkerToDaemon, { type: 'final_output' }>);
    };
    const emitTerminal = (dispatchAttempt: number) => {
      (ds.worker as any).emit('message', {
        type: 'turn_terminal',
        sessionId: ds.session.sessionId,
        turnId: 'delivery-stable-key',
        dispatchAttempt,
        status: 'completed',
      } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    };

    emitFinal(1, 'stale attempt output must stay silent');
    emitTerminal(1);
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    expect(ds.suppressedFinalOutputTurns.get('delivery-stable-key')).toBe(2);

    emitFinal(2, 'current attempt output must stay silent');
    emitTerminal(2);
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(onTurnTerminal).toHaveBeenCalledTimes(2);
    expect(ds.suppressedFinalOutputTurns.get('delivery-stable-key')).toBe(2);
  });

  it('suppresses non-final streaming, TUI, and diagnostic UI for a listener_thread receiver', async () => {
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };
    ds.suppressedFinalOutputTurns = new Map([['delivery-stable-key', 1]]);
    seedReceiverReceipt('listener_thread');
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal: (_ds, terminal) => {
        completeVcMeetingDelivery('/tmp/test-sessions', {
          listenerAppId: 'listener-app', meetingId: 'meeting-1', memberId: 'member-1', memberEpoch: 1,
          deliveryKey: terminal.turnId,
        }, { workerGeneration: 1, dispatchAttempt: terminal.dispatchAttempt });
      },
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'ready', port: 4567, token: 'token', turnId: 'delivery-stable-key', dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'ready' }>);
    (ds.worker as any).emit('message', {
      type: 'screen_update',
      content: 'meeting transcript on screen',
      status: 'working',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    (ds.worker as any).emit('message', {
      type: 'progress_output',
      sessionId: ds.session.sessionId,
      content: 'meeting-derived progress must remain private',
      uuid: 'meeting-progress:1',
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'progress_output' }>);
    (ds.worker as any).emit('message', {
      type: 'tui_prompt',
      description: 'permission needed',
      options: [{ text: 'allow', selected: false }],
      turnId: 'delivery-stable-key',
      dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'tui_prompt' }>);
    (ds.worker as any).emit('message', {
      type: 'user_notify', message: 'submit failed', turnId: 'delivery-stable-key', dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'user_notify' }>);
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ds.workerPort).toBe(4567);
    expect(ds.lastScreenStatus).toBe('working');

    (ds.worker as any).emit('message', {
      type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'delivery-stable-key',
      dispatchAttempt: 1, status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();
    (ds.worker as any).emit('message', {
      type: 'screen_update', content: 'idle after terminal', status: 'idle',
      turnId: 'delivery-stable-key', dispatchAttempt: 1,
    } satisfies Extract<WorkerToDaemon, { type: 'screen_update' }>);
    await Promise.resolve();
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('drops a terminal receipt from a stale or wrongly-bound worker', async () => {
    const ds = makeDs();
    const onTurnTerminal = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'turn_terminal',
      sessionId: 'sid-stale-worker',
      turnId: 'delivery-stable-key',
      status: 'completed',
    } satisfies Extract<WorkerToDaemon, { type: 'turn_terminal' }>);
    await Promise.resolve();

    expect(onTurnTerminal).not.toHaveBeenCalled();
  });

  it('reports the exact worker generation when the process exits', async () => {
    const ds = makeDs();
    const onWorkerExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onWorkerExit,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('exit', 17, 'SIGTERM');
    await Promise.resolve();

    expect(onWorkerExit).toHaveBeenCalledWith(ds, {
      sessionId: ds.session.sessionId,
      workerGeneration: 1,
      code: 17,
      signal: 'SIGTERM',
    });
  });

  it('notifies Lark when a ready worker process really exits unexpectedly', async () => {
    const ds = makeDs();
    ds.suppressRecoveryCard = true;
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'ready', port: 4567, token: 'token', turnId: 'turn-crashed',
    } satisfies Extract<WorkerToDaemon, { type: 'ready' }>);
    (ds.worker as any).emit('exit', 9, 'SIGKILL');
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls.some(call => String(call[1]).includes('异常结束'))).toBe(true);
    expect(sessionReply.mock.calls.some(call => String(call[1]).includes('worker exit code: 9'))).toBe(true);
    expect(sessionReply.mock.calls.some(call => String(call[1]).includes('当前对话因异常已经停止'))).toBe(true);
  });

  it('reports a managed CLI exit even when the Node worker stays alive', async () => {
    const ds = makeDs();
    const onCliExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onCliExit,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'live-capability',
      turnId: 'om_live',
    } satisfies Extract<WorkerToDaemon, { type: 'managed_turn_origin' }>);
    expect(ds.managedTurnOrigin).toEqual({
      capability: 'live-capability',
      turnId: 'om_live',
    });

    (ds.worker as any).emit('message', {
      type: 'claude_exit', code: 9, signal: 'SIGKILL',
    } satisfies Extract<WorkerToDaemon, { type: 'claude_exit' }>);
    await Promise.resolve();

    expect(onCliExit).toHaveBeenCalledWith(ds, {
      sessionId: ds.session.sessionId,
      workerGeneration: 1,
      code: 9,
      signal: 'SIGKILL',
    });
    expect(ds.managedTurnOrigin).toBeUndefined();
  });

  it('ignores stale-worker CLI exit authority changes after replacement', async () => {
    const ds = makeDs();
    const oldWorker = ds.worker as any;
    const replacementWorker = makeDs().worker as any;
    const onCliExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onCliExit,
    });
    __testOnly_setupWorkerHandlers(ds, oldWorker);
    ds.worker = replacementWorker;
    __testOnly_setupWorkerHandlers(ds, replacementWorker);

    replacementWorker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: ds.session.sessionId,
      capability: 'replacement-capability',
      turnId: 'om_replacement',
    } satisfies Extract<WorkerToDaemon, { type: 'managed_turn_origin' }>);

    oldWorker.emit('message', {
      type: 'claude_exit', code: 9, signal: 'SIGKILL',
    } satisfies Extract<WorkerToDaemon, { type: 'claude_exit' }>);
    await Promise.resolve();

    expect(ds.managedTurnOrigin).toEqual({
      capability: 'replacement-capability',
      turnId: 'om_replacement',
    });
    expect(onCliExit).not.toHaveBeenCalled();
  });
});

describe('Codex context exhaustion routing', () => {
  it('routes only a matching current-worker event to the daemon handoff callback', async () => {
    const ds = makeDs();
    const onCodexContextExhausted = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onCodexContextExhausted,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    const event: Extract<WorkerToDaemon, { type: 'codex_context_exhausted' }> = {
      type: 'codex_context_exhausted',
      sessionId: ds.session.sessionId,
      turnId: 'turn-full',
      interruptedUserGoal: 'finish the migration',
    };
    (ds.worker as any).emit('message', event);
    await Promise.resolve();
    expect(onCodexContextExhausted).toHaveBeenCalledWith(ds, event);

    (ds.worker as any).emit('message', { ...event, sessionId: 'wrong-session' });
    await Promise.resolve();
    expect(onCodexContextExhausted).toHaveBeenCalledTimes(1);
  });

  it('routes only a matching current-worker stream disconnect to recovery', async () => {
    const ds = makeDs();
    const onCodexStreamDisconnected = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onCodexStreamDisconnected,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    const event: Extract<WorkerToDaemon, { type: 'codex_stream_disconnected' }> = {
      type: 'codex_stream_disconnected',
      sessionId: ds.session.sessionId,
      turnId: 'turn-stream',
      interruptedUserGoal: 'continue the interrupted task',
    };
    (ds.worker as any).emit('message', event);
    await Promise.resolve();
    expect(onCodexStreamDisconnected).toHaveBeenCalledWith(ds, event);

    (ds.worker as any).emit('message', { ...event, sessionId: 'wrong-session' });
    await Promise.resolve();
    expect(onCodexStreamDisconnected).toHaveBeenCalledTimes(1);
  });

  it('does not auto-restart a Codex source that exits during handoff', async () => {
    const ds = makeDs();
    ds.session.cliId = 'codex';
    ds.pendingCodexFreshHandoff = {
      requestId: 'request-1',
      requestedAt: Date.now(),
      reason: 'context_window_exceeded',
      summaryTurnId: 'summary-turn',
      phase: 'collecting',
    };
    const onCodexHandoffSourceExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onCodexHandoffSourceExit,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      type: 'claude_exit', code: 1, signal: null,
    } satisfies Extract<WorkerToDaemon, { type: 'claude_exit' }>);
    await Promise.resolve();
    expect(onCodexHandoffSourceExit).toHaveBeenCalledWith(ds);
    expect((ds.worker as any).send).not.toHaveBeenCalledWith({ type: 'restart' });
  });

  it('does not auto-restart a Codex App source that exits during stream recovery', async () => {
    const ds = makeDs();
    ds.session.cliId = 'codex-app';
    ds.pendingCodexFreshHandoff = {
      requestId: 'request-stream-1',
      requestedAt: Date.now(),
      reason: 'stream_disconnected',
      summaryTurnId: 'stream-recovery-turn',
      phase: 'migrating',
    };
    const onCodexHandoffSourceExit = vi.fn(async () => {});
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onCodexHandoffSourceExit,
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      type: 'claude_exit', code: 1, signal: null,
    } satisfies Extract<WorkerToDaemon, { type: 'claude_exit' }>);
    await Promise.resolve();
    expect(onCodexHandoffSourceExit).toHaveBeenCalledWith(ds);
    expect((ds.worker as any).send).not.toHaveBeenCalledWith({ type: 'restart' });
  });
});
