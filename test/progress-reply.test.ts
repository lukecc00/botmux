import { describe, expect, it } from 'vitest';
import {
  PROGRESS_REPLY_MAX_CHARS,
  PROGRESS_REPLY_MIN_INTERVAL_MS,
  selectProgressReply,
} from '../src/core/progress-reply.js';

describe('selectProgressReply', () => {
  it('emits only visible working/analyzing snapshots', () => {
    expect(selectProgressReply('implemented header', 'working', {}, 1)?.content)
      .toBe('implemented header');
    expect(selectProgressReply('running tests', 'analyzing', {}, 1)?.content)
      .toBe('running tests');
    expect(selectProgressReply('done', 'idle', {}, 1)).toBeNull();
    expect(selectProgressReply('   ', 'working', {}, 1)).toBeNull();
  });

  it('deduplicates identical content and throttles changed content', () => {
    const first = selectProgressReply('step one', 'working', {}, 1_000)!;
    expect(selectProgressReply('step one', 'working', {
      hash: first.hash,
      sentAt: 1_000,
    }, 1_000 + PROGRESS_REPLY_MIN_INTERVAL_MS)).toBeNull();
    expect(selectProgressReply('step two', 'working', {
      hash: first.hash,
      sentAt: 1_000,
    }, 1_000 + PROGRESS_REPLY_MIN_INTERVAL_MS - 1)).toBeNull();
    expect(selectProgressReply('step two', 'working', {
      hash: first.hash,
      sentAt: 1_000,
    }, 1_000 + PROGRESS_REPLY_MIN_INTERVAL_MS)?.content).toBe('step two');
  });

  it('keeps the newest tail within the Lark-safe cap', () => {
    const result = selectProgressReply('x'.repeat(PROGRESS_REPLY_MAX_CHARS + 20), 'working', {}, 1)!;
    expect(result.content.startsWith('…\n')).toBe(true);
    expect(result.content.endsWith('x'.repeat(PROGRESS_REPLY_MAX_CHARS))).toBe(true);
  });
});
