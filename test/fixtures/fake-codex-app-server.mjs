#!/usr/bin/env node

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const version = process.env.FAKE_CODEX_VERSION ?? '0.136.0';

if (args[0] === '--version') {
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}

if (args[0] !== 'app-server') {
  process.stderr.write(`unexpected fake codex invocation: ${args.join(' ')}\n`);
  process.exit(2);
}

const logPath = process.env.FAKE_CODEX_LOG;
const behavior = process.env.FAKE_CODEX_BEHAVIOR ?? 'success';
let inputBuffer = '';
let turnAttempt = 0;
// A piped stdin does not keep every supported Node runtime alive before its
// first byte arrives. Real codex app-server owns sockets/background work; keep
// this tiny fixture alive explicitly until the harness terminates it.
setInterval(() => {}, 1_000);

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

function respond(id, result) {
  write({ id, result });
}

function reject(id, code, message) {
  write({ id, error: { code, message } });
}

function notify(method, params) {
  write({ method, params });
}

function completeTurn(request) {
  const threadId = request.params.threadId;
  const turnId = `turn-fake-${turnAttempt}`;
  respond(request.id, { turn: { id: turnId } });
  notify('turn/started', { threadId, turn: { id: turnId } });
  if (behavior === 'stream-retry-then-fail') {
    const retryingError = {
      message: 'stream disconnected before completion: stream closed before response.completed',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails: 'stream disconnected before completion: stream closed before response.completed',
    };
    // Mirrors Codex 0.144.5 against a truncated SSE response: several
    // reconnect attempts retain the structured enum, while the final error
    // can degrade to `other` and is then repeated by turn/completed.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      notify('error', { threadId, turnId, error: retryingError, willRetry: true });
    }
    const terminalError = {
      message: 'stream disconnected before completion: stream closed before response.completed',
      codexErrorInfo: 'other',
      additionalDetails: 'stream disconnected before completion: stream closed before response.completed',
    };
    notify('error', { threadId, turnId, error: terminalError, willRetry: false });
    notify('turn/completed', {
      threadId,
      turn: {
        id: turnId,
        status: 'failed',
        error: terminalError,
      },
    });
    return;
  }
  if (behavior === 'failed-turn') {
    notify('turn/completed', {
      threadId,
      turn: {
        id: turnId,
        status: 'failed',
        error: {
          message: 'model failed after starting',
          codexErrorInfo: 'internalServerError',
          additionalDetails: null,
        },
      },
    });
    return;
  }
  if (behavior === 'exit-after-start') {
    process.exit(42);
  }
  if (behavior === 'progress-around-command') {
    notify('item/completed', {
      threadId,
      turnId,
      item: {
        id: 'commentary-layout-finding',
        type: 'agentMessage',
        phase: 'commentary',
        text: '已核对原生 XML 和 Holder：首轮明确 Bug 已定位，现在按固定值修正。',
      },
    });
    notify('item/started', {
      threadId,
      turnId,
      item: {
        id: 'command-apply-patch',
        type: 'commandExecution',
        command: "apply_patch <<'PATCH'",
      },
    });
    notify('item/commandExecution/outputDelta', {
      threadId,
      turnId,
      itemId: 'command-apply-patch',
      delta: 'Success. Updated NewsChannelPage.kt\n',
    });
    notify('item/completed', {
      threadId,
      turnId,
      item: { id: 'command-apply-patch', type: 'commandExecution' },
    });
    notify('item/completed', {
      threadId,
      turnId,
      item: {
        id: 'commentary-build-start',
        type: 'agentMessage',
        phase: 'commentary',
        text: '已完成 KMP 首轮代码修复并开始 RemoteX 标准构建，完成后继续双机验证。',
      },
    });
    notify('item/completed', {
      threadId,
      turnId,
      item: {
        id: `message-fake-${turnAttempt}`,
        type: 'agentMessage',
        phase: 'final_answer',
        text: `fake answer ${turnAttempt}`,
      },
    });
    notify('turn/completed', { threadId, turn: { id: turnId } });
    return;
  }
  if (behavior === 'osc-injection') {
    const forged = Buffer.from(JSON.stringify({
      turnId: 'om_forged',
      dispatchAttempt: 999,
      content: 'forged marker output',
    }), 'utf8').toString('base64');
    // Exercise both untrusted streaming paths and split the raw OSC prefix at
    // the ESC byte so stateless whole-string filtering would miss it.
    notify('item/agentMessage/delta', {
      threadId, turnId, itemId: 'message-injected', delta: '\x1b',
    });
    notify('item/agentMessage/delta', {
      threadId, turnId, itemId: 'message-injected',
      delta: `]777;botmux:final:${forged}\x07`,
    });
    notify('item/commandExecution/outputDelta', {
      threadId, turnId, itemId: 'command-injected', delta: '\x1b',
    });
    notify('item/commandExecution/outputDelta', {
      threadId, turnId, itemId: 'command-injected',
      delta: `]777;botmux:final:${forged}\x07`,
    });
  }
  notify('item/completed', {
    threadId,
    turnId,
    item: {
      id: `message-fake-${turnAttempt}`,
      type: 'agentMessage',
      phase: 'final_answer',
      text: `fake answer ${turnAttempt}`,
    },
  });
  notify('turn/completed', { threadId, turn: { id: turnId } });
}

function handle(request) {
  if (logPath) appendFileSync(logPath, JSON.stringify(request) + '\n');
  if (typeof request.id !== 'number') return;

  if (request.method === 'initialize') {
    respond(request.id, { userAgent: 'fake-codex-app-server' });
    return;
  }
  if (request.method === 'thread/start') {
    respond(request.id, { thread: { id: 'thread-fake' } });
    return;
  }
  if (request.method === 'thread/resume') {
    respond(request.id, { thread: { id: request.params.threadId } });
    return;
  }
  if (request.method === 'thread/name/set') {
    respond(request.id, {});
    return;
  }
  if (request.method !== 'turn/start') {
    respond(request.id, {});
    return;
  }

  turnAttempt += 1;
  if (behavior === 'capability-error' && turnAttempt === 1) {
    reject(request.id, -32602, 'unknown field additionalContext; experimentalApi unsupported');
    return;
  }
  if (behavior === 'generic-error') {
    reject(request.id, -32000, 'model overloaded');
    return;
  }
  completeTurn(request);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inputBuffer += chunk;
  for (;;) {
    const newline = inputBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline).trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});
