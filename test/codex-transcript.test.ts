import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainCodexRollout, codexSessionIdFromRolloutPath, findCodexRolloutBySessionId, findCodexSessionIdByBotmuxSessionId, splitCodexEventsByCutoff, extractLastCodexTurn, isCodexAbnormalTerminationOutput, type CodexBridgeEvent } from '../src/services/codex-transcript.js';

let dir: string;
let path: string;

function ev(obj: any): string {
  return JSON.stringify(obj) + '\n';
}

function userResponseItem(text: string, ts = '2026-04-29T07:00:00.000Z') {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  };
}

function assistantFinalResponseItem(text: string, ts = '2026-04-29T07:00:01.000Z') {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text }],
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-transcript-'));
  path = join(dir, 'rollout.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('codexSessionIdFromRolloutPath', () => {
  it('extracts sessionId suffix from a canonical rollout path', () => {
    expect(codexSessionIdFromRolloutPath(
      '/root/.codex/sessions/2026/04/29/rollout-2026-04-29T07-04-39-019dd80d-d922-7a11-8339-0208d8c5b4ec.jsonl',
    )).toBe('019dd80d-d922-7a11-8339-0208d8c5b4ec');
  });

  it('returns undefined for non-rollout paths', () => {
    expect(codexSessionIdFromRolloutPath('/var/log/syslog')).toBeUndefined();
    expect(codexSessionIdFromRolloutPath('/root/.codex/history.jsonl')).toBeUndefined();
  });

  it('returns undefined when filename is malformed', () => {
    expect(codexSessionIdFromRolloutPath('/root/.codex/sessions/foo/bar.jsonl')).toBeUndefined();
    expect(codexSessionIdFromRolloutPath('rollout-no-suffix-just-text.jsonl')).toBeUndefined();
  });
});

describe('Codex empty task completion', () => {
  it('emits an ambiguous candidate boundary when task_complete has no final message', () => {
    writeFileSync(path,
      ev(userResponseItem('keep working'))
      + ev({
        timestamp: '2026-04-29T07:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'native-turn', last_agent_message: null },
      }),
    );
    const out = drainCodexRollout(path, 0).events;
    expect(out.at(-1)).toMatchObject({
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'ambiguous',
      terminalErrorCode: 'codex_task_complete_without_final_candidate',
    });
  });

  it('preserves a structured context-window failure from task_complete', () => {
    writeFileSync(path,
      ev(userResponseItem('keep working'))
      + ev({
        timestamp: '2026-04-29T07:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'native-turn',
          last_agent_message: null,
          error: {
            message: "Codex ran out of room in the model's context window.",
            codex_error_info: 'context_window_exceeded',
          },
        },
      }),
    );
    expect(drainCodexRollout(path, 0).events.at(-1)).toMatchObject({
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'failed',
      terminalErrorCode: 'codex_context_window_exceeded',
    });
  });

  it('accepts the legacy PascalCase context-window error discriminator', () => {
    writeFileSync(path,
      ev(userResponseItem('keep working'))
      + ev({
        timestamp: '2026-04-29T07:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          last_agent_message: null,
          error: { codex_error_info: 'ContextWindowExceeded' },
        },
      }),
    );
    expect(drainCodexRollout(path, 0).events.at(-1)).toMatchObject({
      terminalStatus: 'failed',
      terminalErrorCode: 'codex_context_window_exceeded',
    });
  });

  it('recognizes only known recoverable Codex terminal diagnostics', () => {
    expect(isCodexAbnormalTerminationOutput(
      '■ stream disconnected before completion: stream closed before response.completed',
    )).toBe(true);
    expect(isCodexAbnormalTerminationOutput('Stream closed before response.completed')).toBe(true);
    // Context-window failures use task_complete.error.codex_error_info. Do not
    // infer them from screen text: a user can paste this exact diagnostic.
    expect(isCodexAbnormalTerminationOutput(
      "■ Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    )).toBe(false);
    expect(isCodexAbnormalTerminationOutput('• Context compacted')).toBe(false);
    expect(isCodexAbnormalTerminationOutput('Please explain the model context window')).toBe(false);
    expect(isCodexAbnormalTerminationOutput('已发送结果，等待下一条消息')).toBe(false);
    expect(isCodexAbnormalTerminationOutput('')).toBe(false);
  });

  it('does not duplicate a normal task_complete that carries a final message', () => {
    writeFileSync(path,
      ev(userResponseItem('keep working'))
      + ev(assistantFinalResponseItem('done'))
      + ev({
        timestamp: '2026-04-29T07:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'native-turn', last_agent_message: 'done' },
      }),
    );
    expect(drainCodexRollout(path, 0).events.map(event => event.kind))
      .toEqual(['user', 'assistant_final']);
  });
});

describe('findCodexRolloutBySessionId', () => {
  it('honors CODEX_HOME when locating rollout transcripts', () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const sid = '019dd80d-d922-7a11-8339-0208d8c5b4ec';
    const rolloutDir = join(codexHome, 'sessions', '2026', '06', '02');
    const rolloutPath = join(rolloutDir, `rollout-2026-06-02T08-14-07-${sid}.jsonl`);
    process.env.CODEX_HOME = codexHome;
    try {
      mkdirSync(rolloutDir, { recursive: true });
      writeFileSync(rolloutPath, '');
      expect(findCodexRolloutBySessionId(sid)).toBe(rolloutPath);
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe('findCodexSessionIdByBotmuxSessionId', () => {
  it('bounds the history scan to the requested tail window', () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const historyPath = join(codexHome, 'history.jsonl');
    process.env.CODEX_HOME = codexHome;
    try {
      const oldLine = JSON.stringify({ session_id: 'old-codex-sid', text: 'hello <session_id>botmux-tail-sid</session_id>' });
      const padding = Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({ session_id: `pad-${i}`, text: 'x'.repeat(100) }),
      ).join('\n');
      writeFileSync(historyPath, `${oldLine}\n${padding}\n`);

      // The marker lives outside a 1 KiB tail window — must not be found
      // (and, crucially, the whole multi-MB file must not be slurped).
      expect(findCodexSessionIdByBotmuxSessionId('botmux-tail-sid', { maxTailBytes: 1024 })).toBeUndefined();
      // The default window is large enough to cover the entire file here.
      expect(findCodexSessionIdByBotmuxSessionId('botmux-tail-sid')).toBe('old-codex-sid');
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('honors CODEX_HOME and returns the newest history entry for a botmux session', () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const historyPath = join(codexHome, 'history.jsonl');
    process.env.CODEX_HOME = codexHome;
    try {
      writeFileSync(historyPath, [
        JSON.stringify({ session_id: 'older-codex-sid', text: 'hello <session_id>botmux-sid</session_id>' }),
        JSON.stringify({ session_id: 'unrelated-codex-sid', text: 'hello another-session' }),
        JSON.stringify({ session_id: 'newer-codex-sid', text: 'resume <session_id>botmux-sid</session_id>' }),
      ].join('\n') + '\n');

      expect(findCodexSessionIdByBotmuxSessionId('botmux-sid')).toBe('newer-codex-sid');
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe('splitCodexEventsByCutoff', () => {
  const ev = (uuid: string, kind: 'user' | 'assistant_final', timestampMs: number, text = 't'): CodexBridgeEvent =>
    ({ uuid, timestampMs, kind, text });

  it('partitions by strict less-than: events at cutoff land in live', () => {
    const events = [ev('a', 'user', 50), ev('b', 'user', 100), ev('c', 'assistant_final', 150)];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history.map(e => e.uuid)).toEqual(['a']);
    expect(out.live.map(e => e.uuid)).toEqual(['b', 'c']);
  });

  it('all-history when every event predates cutoff', () => {
    const events = [ev('a', 'user', 10), ev('b', 'assistant_final', 20)];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history.map(e => e.uuid)).toEqual(['a', 'b']);
    expect(out.live).toEqual([]);
  });

  it('all-live when every event is at-or-after cutoff', () => {
    const events = [ev('a', 'user', 100), ev('b', 'assistant_final', 200)];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history).toEqual([]);
    expect(out.live.map(e => e.uuid)).toEqual(['a', 'b']);
  });

  it('preserves event order within each partition', () => {
    const events = [
      ev('hist1', 'user', 10),
      ev('live1', 'user', 200),
      ev('hist2', 'assistant_final', 50),
      ev('live2', 'assistant_final', 250),
    ];
    const out = splitCodexEventsByCutoff(events, 100);
    expect(out.history.map(e => e.uuid)).toEqual(['hist1', 'hist2']);
    expect(out.live.map(e => e.uuid)).toEqual(['live1', 'live2']);
  });

  it('empty input returns empty partitions', () => {
    const out = splitCodexEventsByCutoff([], 100);
    expect(out.history).toEqual([]);
    expect(out.live).toEqual([]);
  });
});

describe('extractLastCodexTurn', () => {
  const mk = (kind: 'user' | 'assistant_final', text: string) => ({ kind, text });

  it('returns last user/assistant_final pair from a typical history', () => {
    const out = extractLastCodexTurn([
      mk('user', 'u1'), mk('assistant_final', 'a1'),
      mk('user', 'u2'), mk('assistant_final', 'a2'),
    ]);
    expect(out).toEqual({ userText: 'u2', assistantText: 'a2' });
  });

  it('pairs the last assistant_final with the nearest preceding user', () => {
    // u1 没回复 → 配 (u2, a) 而不是 (u1, a)
    const out = extractLastCodexTurn([
      mk('user', 'u1'),
      mk('user', 'u2'),
      mk('assistant_final', 'a'),
    ]);
    expect(out).toEqual({ userText: 'u2', assistantText: 'a' });
  });

  it('returns undefined when there is no assistant_final', () => {
    expect(extractLastCodexTurn([mk('user', 'u1'), mk('user', 'u2')])).toBeUndefined();
  });

  it('returns undefined when assistant_final has no preceding user', () => {
    // 罕见但可能：rollout 起手就是 assistant message（例如 resume 截断）
    expect(extractLastCodexTurn([mk('assistant_final', 'a')])).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(extractLastCodexTurn([])).toBeUndefined();
  });

  it('ignores trailing user that has no reply yet', () => {
    // ...u1 a1 u2  → 最后一对完整 turn 仍是 (u1, a1)
    const out = extractLastCodexTurn([
      mk('user', 'u1'), mk('assistant_final', 'a1'),
      mk('user', 'u2'),
    ]);
    expect(out).toEqual({ userText: 'u1', assistantText: 'a1' });
  });
});

describe('drainCodexRollout', () => {
  it('returns empty for missing file', () => {
    const r = drainCodexRollout(join(dir, 'missing.jsonl'), 0);
    expect(r.events).toEqual([]);
    expect(r.newOffset).toBe(0);
  });

  it('extracts user + assistant_final from response_item', () => {
    writeFileSync(path,
      ev(userResponseItem('hello there')) +
      ev(assistantFinalResponseItem('hi back')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('hello there');
    expect(r.events[1].kind).toBe('assistant_final');
    expect(r.events[1].text).toBe('hi back');
  });

  it('skips developer role messages', () => {
    writeFileSync(path,
      ev({
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys instr' }] },
      }) +
      ev(userResponseItem('real user prompt')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('real user prompt');
  });

  it('extracts assistant phase=commentary as clean progress, separate from final output', () => {
    writeFileSync(path,
      ev({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: '已完成修复，正在跑边界测试。' }],
        },
      }) +
      ev(assistantFinalResponseItem('done')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toMatchObject({
      kind: 'assistant_progress',
      text: '已完成修复，正在跑边界测试。',
    });
    expect(r.events[1]).toMatchObject({ kind: 'assistant_final', text: 'done' });
  });

  it('skips reasoning / function_call / function_call_output / event_msg', () => {
    writeFileSync(path,
      ev({ type: 'response_item', payload: { type: 'reasoning' } }) +
      ev({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }) +
      ev({ type: 'response_item', payload: { type: 'function_call_output' } }) +
      ev({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'not picked up' } }) +
      ev(userResponseItem('actual prompt')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('actual prompt');
  });

  it('skips messages with no input_text/output_text content', () => {
    writeFileSync(path,
      ev({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'image_url', url: 'x' }] },
      }) +
      ev(userResponseItem('text after image-only')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('text after image-only');
  });

  it('ignores malformed JSON lines', () => {
    writeFileSync(path,
      'not json\n' +
      ev(userResponseItem('after bad line')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('after bad line');
  });

  it('byte-offset stable: re-drain from newOffset returns no events', () => {
    writeFileSync(path,
      ev(userResponseItem('first')) +
      ev(assistantFinalResponseItem('reply')));
    const first = drainCodexRollout(path, 0);
    const second = drainCodexRollout(path, first.newOffset);
    expect(second.events).toEqual([]);
    expect(second.newOffset).toBe(first.newOffset);
  });

  it('appended events drain incrementally', () => {
    writeFileSync(path, ev(userResponseItem('first')));
    const r1 = drainCodexRollout(path, 0);
    expect(r1.events).toHaveLength(1);
    appendFileSync(path, ev(assistantFinalResponseItem('reply')));
    const r2 = drainCodexRollout(path, r1.newOffset);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].kind).toBe('assistant_final');
  });

  it('partial trailing line is held back as pendingTail', () => {
    writeFileSync(path, ev(userResponseItem('complete')) + '{"type":"response_item",partial');
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.pendingTail).toContain('partial');
    expect(r.newOffset).toBeLessThan(statSync(path).size);
  });

  it('uuid encodes path:byteStart and is stable across re-drains', () => {
    writeFileSync(path,
      ev(userResponseItem('uuid-one')) +
      ev(userResponseItem('uuid-two')));
    const r = drainCodexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].uuid).toMatch(/^.+\.jsonl:0$/);
    expect(r.events[1].uuid).not.toBe(r.events[0].uuid);
    // Re-drain from 0 should produce identical uuids.
    const r2 = drainCodexRollout(path, 0);
    expect(r2.events.map(e => e.uuid)).toEqual(r.events.map(e => e.uuid));
  });

  it('truncated file (size < fromOffset) re-drains from top', () => {
    writeFileSync(path,
      ev(userResponseItem('original message that is reasonably long for offset')) +
      ev(assistantFinalResponseItem('long original answer to take up bytes')));
    const r1 = drainCodexRollout(path, 0);
    // Simulate truncation: rewrite with strictly shorter content so the new
    // size is below r1.newOffset and the re-drain branch fires.
    writeFileSync(path, ev(userResponseItem('s')));
    const r2 = drainCodexRollout(path, r1.newOffset);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].text).toBe('s');
  });
});
