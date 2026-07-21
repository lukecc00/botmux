import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

function migrationSource(): string {
  const start = daemonSource.indexOf('async function migrateCodexHandoffToFreshSession(');
  const end = daemonSource.indexOf('\nfunction persistCodexHandoff(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return daemonSource.slice(start, end);
}

describe('Codex handoff Lark routing', () => {
  it('replaces the native session without creating another Lark topic', () => {
    const source = migrationSource();
    expect(source).toContain('const anchor = sessionAnchorId(source);');
    expect(source).toContain('sessionReply(\n        anchor,\n        buildFreshCodexHandoffTopic(');
    expect(source).not.toContain('await sendMessage(');
    expect(source).not.toContain("sendMessage(\n        source.larkAppId,\n        source.chatId");
  });

  it('repairs a legacy persisted new-topic route back to the source topic', () => {
    const source = migrationSource();
    expect(source).toContain('const persistedAnchor = handoff.newTopicAnchor;');
    expect(source).toContain('if (persistedAnchor && persistedAnchor !== anchor)');
    expect(source).toContain('handoff.newTopicAnchor = anchor;');
    expect(source).toContain('if (!sourceTopicNoticeSentAt)');
    expect(source).toContain('codexHandoffSourceNoticeUuid(handoff.requestId, anchor)');
    expect(source).toContain('sourceTopicNoticeSentAt: handoff.sourceTopicNoticeSentAt');
    expect(source).toContain('session.rootMessageId === persistedAnchor');
    expect(source).toContain('session.rootMessageId = anchor;');
    expect(source).toContain("session.scope = 'thread';");
  });

  it('atomically replaces the same-topic runtime and suppresses a false stop notice', () => {
    const source = migrationSource();
    expect(source).toContain('sessionKey(anchor, source.larkAppId)');
    expect(source).toContain('{ suppressPreviousStopNotice: true }');
    expect(source).toContain('suppressStopNotice: true');
    expect(source).toContain('forkWorker(fresh, input, { resume: false });');
  });
});
