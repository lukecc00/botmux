import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startOutboxWatcher } from '../src/adapters/backend/sandbox.js';
import {
  managedOriginCapabilityPath,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', join(__dirname, '..', 'src', 'cli.ts'), ...args,
    ], {
      cwd: join(__dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${stderr}`));
    }, 10_000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('cmdSend hook context wiring', () => {
  it('delegates CLI session snapshot loading to the session-store gate (scope repair lives behind it)', () => {
    const loadSessionsStart = cliSource.indexOf('function loadSessions()');
    expect(loadSessionsStart).toBeGreaterThanOrEqual(0);
    const loadSessionsEnd = cliSource.indexOf('\nfunction ', loadSessionsStart);
    const loadSessions = cliSource.slice(loadSessionsStart, loadSessionsEnd);

    // The scope repair moved behind the store gate together with the loader
    // itself — repair-on-load behavior is asserted in test/session-store.test.ts
    // (loadAllSessionsSnapshot). The CLI must not regrow a parallel reader or
    // the unlocked whole-file writer it once had.
    expect(loadSessions).toContain('loadAllSessionsSnapshot(');
    expect(loadSessions).not.toContain('readFileSync');
    expect(cliSource).not.toContain('function saveSession(');
  });

  it('passes the current session id into outbound send/reply hooks', () => {
    expect(cliSource).toContain('const hookContext = {');
    expect(cliSource).toMatch(/sendMessage\(\s*appId,\s*sendTarget\.chatId,\s*content,\s*msgType,\s*uuid,\s*hookContext,/);
    expect(cliSource).toMatch(/replyMessage\(\s*appId,\s*sendTarget\.rootMessageId,\s*content,\s*msgType,\s*sendTarget\.mode === 'thread',\s*uuid,\s*hookContext,/);
  });

  it('resolves mention-back from the exact turn instead of the latest queued sender', () => {
    expect(cliSource).toContain(
      'const replyTargetSenderOpenId = explicitVcMeetingImOrigin?.replyTargetSenderOpenId',
    );
    expect(cliSource).toContain('?? turnReplyTarget?.senderOpenId');
    expect(cliSource).toContain('hasQuoteTargetSender: !!replyTargetSenderOpenId');
    expect(cliSource).toMatch(/mentions\.push\(\{ open_id: replyTargetSenderOpenId, name: '' \}\)/);
  });

  it('uses the daemon live-turn UUID for an ordinary explicit progress send', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain('let ordinaryBridgeOutputUuid');
    expect(cmdSend).toContain('providerUuid?: unknown;');
    expect(cmdSend).toContain('ordinaryBridgeOutputUuid = payload.providerUuid;');
    expect(cmdSend.indexOf('ordinaryBridgeOutputUuid = payload.providerUuid;'))
      .toBeLessThan(cmdSend.indexOf("messageId = await dispatchPrimary(nativeProgressCardJson, 'interactive')"));
  });

  it('freezes VC listener replay content and indexes only the successful primary output', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain('const canonicalOutput = prepared?.canonicalOutput ?? proposedOutput;');
    expect(cmdSend).toContain('prepareVcMeetingDeliveryReply(');
    expect(cmdSend).toContain('vcMeetingDeliveryReplyOrigin');
    expect(cmdSend).toContain('content: canonicalOutput.content');
    expect(cmdSend).toContain('msgType: canonicalOutput.msgType');
    expect(cmdSend).toContain('quoteTargetId: canonicalOutput.quoteTargetId');
    expect(cmdSend).toMatch(
      /const dispatchAfterOriginGate = async \([^)]*\): Promise<string> => \{[\s\S]*?revalidateVcMeetingManagedSend\(\);/,
    );
    expect(cmdSend).toMatch(/const dispatch = async \([^)]*\): Promise<string> => \{[\s\S]*?dispatchAfterOriginGate\(/);
    expect(cmdSend).toMatch(
      /const dispatchPrimary = async \([^)]*\): Promise<string> => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*revalidateVcMeetingManagedSend\(\);/,
    );
    expect(cmdSend).toContain('recordVcMeetingPrimaryOutput(result.messageId, canonicalOutput.targetChatId);');
    expect(cmdSend.indexOf('recordVcMeetingPrimaryOutput(result.messageId'))
      .toBeGreaterThan(cmdSend.indexOf('const result = await dispatchPrimaryMessage('));
    expect(cmdSend).toContain('const managedControlError = managedVcSendControlError({');
    expect(cmdSend).toContain('const managedPayloadError = managedVcSendPayloadError({');
    expect(cmdSend).toContain('fileCount: files.length');
    expect(cmdSend).toContain('videoCount: videoAttachments.length');
    expect(cmdSend).toContain('containsNativeAtTag: containsLarkAtTag(content)');
    expect(cmdSend).toContain('const managedRenderedPayloadError = managedVcSendPayloadError({');
    expect(cmdSend).toContain('containsNativeAtTag: containsLarkAtTag(text)');
    expect(cmdSend).toContain('if (!noMention && !isSlashSend && !vcMeetingManagedSendOrigin)');
    expect(cmdSend).toContain('if (!sendTopLevel && !vcMeetingManagedSendOrigin)');
    expect(cmdSend.indexOf('const managedPayloadError = managedVcSendPayloadError({'))
      .toBeLessThan(cmdSend.indexOf("const { sendMessage, replyMessage, uploadImage, uploadFile"));
    expect(cmdSend.indexOf('const managedPayloadError = managedVcSendPayloadError({'))
      .toBeLessThan(cmdSend.indexOf("const { synthesizeVoiceOpus }"));
    expect(cmdSend.indexOf('const managedRenderedPayloadError = managedVcSendPayloadError({'))
      .toBeGreaterThan(cmdSend.indexOf('BOTMUX_CARD_PREPARED_CONTENT_FILE'));
    expect(cmdSend.indexOf('const managedRenderedPayloadError = managedVcSendPayloadError({'))
      .toBeLessThan(cmdSend.indexOf('imageKeys.push(await uploadImage'));
    expect(cmdSend).toContain('const managedQuoteError = managedVcQuoteError({');
    expect(cmdSend).toContain('const managedCustomCardError = managedVcCustomCardError(');
    expect(cmdSend).toMatch(/sessionQuoteTargetId: vcMeetingDeliveryReplyOrigin\s*\? undefined/);
    expect(cmdSend).toContain('const prepared = prepareVcMeetingListenerReply(proposedOutput);');
    expect(cmdSend).toMatch(/canonicalOutput\.msgType,[\s\S]*?prepared\?\.providerKey/);
    expect(cmdSend).toContain('...(prepared ? { suppressHook: true } : {})');
    expect(cmdSend).toContain('const managedProviderOptions = outboundMessageOptions(!!prepared);');
    expect(cmdSend).toContain('...(vcMeetingManagedSendOrigin ? { maxMessages: 1 } : {})');
  });

  it('defaults an omitted response kind to non-final while keeping feedback indexing final-only', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain("const responseKindOccurrences = rest.filter(token => token === '--response-kind' || token.startsWith('--response-kind=')).length");
    expect(cmdSend).toContain("responseKindOccurrences > 1");
    expect(cmdSend).toContain("flagPresentButValueMissing(rest, '--response-kind')");
    expect(cmdSend).toContain("const effectiveResponseKind = responseKind ?? 'progress'");
    expect(cmdSend).not.toContain('启用最终回答反馈后，必须显式指定 --response-kind progress|final');
    expect(cmdSend).toContain('无法确认本次提问者身份，不能发送带反馈控件的最终回答');
    expect(cmdSend).toContain('requesterSubjectId: feedbackRequesterSubjectId');
    expect(cmdSend).not.toContain("feedbackPolicy && responseKind === 'final'");
    expect(cmdSend).toContain("feedbackPolicy && effectiveResponseKind === 'final'");
    expect(cmdSend).toContain('const deliveryTurnId = currentTurnId ?? `send:${messageId}`');
    expect(cmdSend).toContain('const correlationDiscriminator = currentTurnId ? messageId : undefined');
    expect(cmdSend).toContain('turnId: deliveryTurnId');
    expect(cmdSend).toContain('correlationDiscriminator,');
    expect(cmdSend).not.toContain('const deliveryTurnId = `send:${messageId}`');
    expect(cmdSend).not.toContain('--feedback-level');
    const primarySend = cmdSend.indexOf('messageId = await dispatchPrimary');
    const feedbackIndex = cmdSend.indexOf('feedback indexing failed after delivery');
    expect(primarySend).toBeGreaterThanOrEqual(0);
    expect(feedbackIndex).toBeGreaterThan(primarySend);
    expect(cmdSend.slice(cmdSend.lastIndexOf('try {', feedbackIndex), feedbackIndex)).toContain('getSkillFeedbackStore');
    expect(cmdSend).toContain('policy: feedbackPolicy');
    expect(cmdSend).toContain('baseCard: feedbackBaseCard');
    expect(cmdSend).toContain('buildFeedbackElement(feedbackPolicy)');
  });

  it('queues same-topic explicit finals for topic-group memory after delivery', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain('buildTopicGroupMemoryFinalDeliveryPayload({');
    expect(cmdSend).toContain('responseKind: effectiveResponseKind');
    expect(cmdSend).toContain("path: '/api/topic-group-memory/final-delivery'");
    expect(cmdSend).toContain('sameTopic: (shouldRecordBridgeMarker || !!deferredTopicRootMessageIdForOutput)');
    const primarySend = cmdSend.indexOf('messageId = await dispatchPrimary');
    const markerWrite = cmdSend.indexOf('recordBridgeSendMarker(sentAtMs, messageId, text)');
    const memoryPost = cmdSend.indexOf("path: '/api/topic-group-memory/final-delivery'");
    expect(markerWrite).toBeGreaterThan(primarySend);
    expect(memoryPost).toBeGreaterThan(markerWrite);
  });
});
