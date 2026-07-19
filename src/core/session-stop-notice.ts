import { createHash, randomUUID } from 'node:crypto';
import { localeForBot, t } from '../i18n/index.js';
import { logger } from '../utils/logger.js';
import { fallbackTurnId } from './reply-target.js';
import { isDocNativeSession, sessionAnchorId } from './types.js';
import type { DaemonSession } from './types.js';

export type SessionStopKind = 'ended' | 'unexpected';

/**
 * Build the final, high-attention message for a conversation that can no
 * longer continue.  Keep this pure so every close surface (/close, card,
 * dashboard and worker death) uses the same recipient and wording.
 */
export function buildSessionStopNotice(
  ds: Pick<DaemonSession, 'larkAppId' | 'session'>,
  kind: SessionStopKind,
  recipientOverride?: string,
): string {
  const latestBotOpenId = ds.session.quoteTargetSenderIsBot
    ? ds.session.quoteTargetSenderOpenId
    : undefined;
  const recipient = [
    recipientOverride,
    ds.session.lastCallerOpenId,
    ds.session.ownerOpenId,
    ds.session.creatorOpenId,
  ].find(candidate => candidate && candidate !== latestBotOpenId);
  const safeRecipient = recipient && /^[A-Za-z0-9_-]{1,128}$/.test(recipient)
    ? recipient
    : undefined;
  const at = safeRecipient ? `<at user_id="${safeRecipient}"></at> ` : '';
  return `${at}${t(
    kind === 'unexpected' ? 'worker.session_stopped_unexpected' : 'worker.session_stopped',
    undefined,
    localeForBot(ds.larkAppId),
  )}`;
}

/** Stable provider key makes concurrent close/exit paths provider-idempotent. */
export function sessionStopNoticeUuid(sessionId: string, lifecycleId: string): string {
  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(lifecycleId)
    .digest('hex')
    .slice(0, 40);
  return `bmxs_${digest}`;
}

export type SessionStopReply = (
  rootId: string,
  content: string,
  msgType?: string,
  larkAppId?: string,
  turnId?: string,
  opts?: { uuid?: string },
) => Promise<string>;

/**
 * Send once per in-memory lifecycle and with one stable provider UUID, so an
 * explicit close racing the child-process exit cannot double-notify.
 */
export function notifySessionStopped(
  ds: DaemonSession,
  reply: SessionStopReply,
  kind: SessionStopKind = 'ended',
  options: { recipientOpenId?: string; turnId?: string } = {},
): Promise<void> {
  if (ds.stopNoticeSent) return ds.stopNoticeInFlight ?? Promise.resolve();
  if (ds.session.vcMeetingReceiver || isDocNativeSession(ds)) return Promise.resolve();
  ds.stopNoticeSent = true;
  ds.stopNoticeLifecycleId ??= randomUUID();
  const delivery = reply(
    sessionAnchorId(ds),
    buildSessionStopNotice(ds, kind, options.recipientOpenId),
    'text',
    ds.larkAppId,
    fallbackTurnId(ds, options.turnId),
    { uuid: sessionStopNoticeUuid(ds.session.sessionId, ds.stopNoticeLifecycleId) },
  ).then(() => undefined).catch((err: unknown) => {
    logger.error(
      `[${ds.session.sessionId.slice(0, 8)}] Failed to deliver session stop notice: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }).finally(() => {
    ds.stopNoticeInFlight = undefined;
  });
  ds.stopNoticeInFlight = delivery;
  return delivery;
}
