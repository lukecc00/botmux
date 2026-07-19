import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDefaultLocale } from '../src/i18n/index.js';
import {
  buildSessionStopNotice,
  notifySessionStopped,
  sessionStopNoticeUuid,
} from '../src/core/session-stop-notice.js';
import type { DaemonSession } from '../src/core/types.js';

function makeDs(overrides: Partial<DaemonSession['session']> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sid-stop-notice',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'Stop notice',
      status: 'active',
      createdAt: '2026-07-19T00:00:00.000Z',
      lastCallerOpenId: 'ou_latest',
      ownerOpenId: 'ou_owner',
      creatorOpenId: 'ou_creator',
      ...overrides,
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1,
    cliVersion: '1',
    lastMessageAt: 2,
    hasHistory: true,
  } as DaemonSession;
}

beforeEach(() => setDefaultLocale('zh'));

describe('session stop notice', () => {
  it('@s the latest caller and falls back through owner then creator', () => {
    expect(buildSessionStopNotice(makeDs(), 'ended')).toBe(
      '<at user_id="ou_latest"></at> 当前对话已经停止，请关注。',
    );
    expect(buildSessionStopNotice(makeDs({ lastCallerOpenId: undefined }), 'ended'))
      .toContain('<at user_id="ou_owner"></at>');
    expect(buildSessionStopNotice(makeDs({ lastCallerOpenId: undefined, ownerOpenId: undefined }), 'ended'))
      .toContain('<at user_id="ou_creator"></at>');
  });

  it('marks unexpected termination clearly', () => {
    expect(buildSessionStopNotice(makeDs(), 'unexpected')).toContain('因异常已经停止');
  });

  it('can address the explicit closer and rejects malformed mention ids', () => {
    expect(buildSessionStopNotice(makeDs(), 'ended', 'ou_closer'))
      .toContain('<at user_id="ou_closer"></at>');
    expect(buildSessionStopNotice(makeDs(), 'ended', 'ou_bad\"></at>'))
      .not.toContain('<at user_id=');
  });

  it('does not @ a sender explicitly identified as a bot', () => {
    const ds = makeDs({
      lastCallerOpenId: 'ou_peer_bot',
      quoteTargetSenderOpenId: 'ou_peer_bot',
      quoteTargetSenderIsBot: true,
    });
    expect(buildSessionStopNotice(ds, 'ended')).toContain('<at user_id="ou_owner"></at>');
    expect(buildSessionStopNotice(makeDs({
      lastCallerOpenId: 'ou_peer_bot', ownerOpenId: undefined, creatorOpenId: 'ou_peer_bot',
      quoteTargetSenderOpenId: 'ou_peer_bot', quoteTargetSenderIsBot: true,
    }), 'ended')).not.toContain('<at user_id=');
  });

  it('sends only once with a stable provider UUID', async () => {
    const ds = makeDs();
    let resolveSend!: (id: string) => void;
    const reply = vi.fn(() => new Promise<string>(resolve => { resolveSend = resolve; }));

    const first = notifySessionStopped(ds, reply);
    const second = notifySessionStopped(ds, reply, 'unexpected');
    expect(reply).toHaveBeenCalledTimes(1);
    const opts = reply.mock.calls[0]?.[5] as { uuid?: string } | undefined;
    expect(reply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('<at user_id="ou_latest"></at>'),
      'text',
      'app_test',
      undefined,
      { uuid: expect.stringMatching(/^bmxs_/) },
    );
    expect(opts?.uuid).toBe(sessionStopNoticeUuid('sid-stop-notice', ds.stopNoticeLifecycleId!));
    resolveSend('om_notice');
    await Promise.all([first, second]);
  });

  it('does not leak auxiliary notices from doc-native or meeting receiver sessions', async () => {
    const reply = vi.fn(async () => 'om_notice');
    const doc = makeDs();
    doc.scope = 'chat';
    doc.chatId = 'doc:token';
    const receiver = makeDs({ vcMeetingReceiver: {
      listenerAppId: 'listener', meetingId: 'm1', memberId: 'member', memberEpoch: 1,
    } });

    await notifySessionStopped(doc, reply);
    await notifySessionStopped(receiver, reply);
    expect(reply).not.toHaveBeenCalled();
  });
});
