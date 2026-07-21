import { createHash } from 'node:crypto';
import { normaliseForFingerprint } from './claude-transcript.js';

/** Stable Lark UUID shared by transcript-native progress and an explicit
 * `botmux send --no-mention` of the same text. Turn scoping preserves
 * intentional repeats in later turns while Lark provides the cross-process
 * atomic dedupe fence. Finals retain their native UUID namespace so an equal
 * progress body can never swallow the final card's user notification. */
export function bridgeProgressProviderUuid(
  sessionId: string,
  turnId: string,
  content: string,
): string | undefined {
  const normalized = normaliseForFingerprint(content);
  if (!sessionId || !turnId || !normalized) return undefined;
  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(turnId)
    .update('\0')
    .update(normalized)
    .digest('hex')
    .slice(0, 40);
  return `bmxp_${digest}`;
}
