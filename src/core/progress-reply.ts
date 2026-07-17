import { createHash } from 'node:crypto';

export const PROGRESS_REPLY_MIN_INTERVAL_MS = 15_000;
export const PROGRESS_REPLY_MAX_CHARS = 6_000;

export interface ProgressReplyState {
  hash?: string;
  sentAt?: number;
}

/** Select filtered terminal output for a standalone in-thread progress reply. */
export function selectProgressReply(
  content: string,
  status: string,
  state: ProgressReplyState,
  now = Date.now(),
): { content: string; hash: string } | null {
  if (status !== 'working' && status !== 'analyzing') return null;
  const normalized = content.replace(/\r/g, '').trim();
  if (!normalized) return null;
  const clipped = normalized.length > PROGRESS_REPLY_MAX_CHARS
    ? `…\n${normalized.slice(-PROGRESS_REPLY_MAX_CHARS)}`
    : normalized;
  const hash = createHash('sha256').update(clipped).digest('hex');
  if (hash === state.hash) return null;
  if (state.sentAt !== undefined && now - state.sentAt < PROGRESS_REPLY_MIN_INTERVAL_MS) return null;
  return { content: clipped, hash };
}
