/**
 * Fresh-conversation CLI runner for topic-group memory distillation.
 *
 * The daemon inherits the current session's CLI selection, binary override,
 * wrapper and model, but never its native session id. Each invocation uses the
 * CLI's one-shot structured-output surface and a private temporary cwd, then is
 * destroyed. The main Agent conversation is never resumed or mutated.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapterSync, locateOnPath } from '../adapters/cli/registry.js';
import type { CliId, IsolatedStructuredRunOutputMode } from '../adapters/cli/types.js';
import { buildWrappedLaunch } from '../setup/cli-selection.js';
import {
  buildTopicGroupMemoryDistillationPrompt,
  buildTopicGroupMemoryDistillationSystemPrompt,
  parseTopicGroupMemoryLlmPatch,
  TOPIC_GROUP_MEMORY_PATCH_SCHEMA,
  TopicGroupMemoryLlmError,
  type TopicGroupMemoryLlmInput,
  type TopicGroupMemoryLlmPatch,
} from './topic-group-memory-llm-distiller.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const SCRATCH_PREFIX = 'botmux-topic-memory-distill-';

export interface TopicGroupMemoryCliContext {
  cliId: CliId;
  cliPathOverride?: string;
  wrapperCli?: string;
  model?: string;
  env?: Readonly<Record<string, string>>;
}

export interface TopicGroupMemoryCliInvocation {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  outputMode: IsolatedStructuredRunOutputMode;
  outputPath: string;
  timeoutMs: number;
}

export interface TopicGroupMemoryCliDistillerDeps {
  timeoutMs?: number;
  invokeCli?: (invocation: TopicGroupMemoryCliInvocation) => Promise<string>;
  scratchParent?: string;
  removeScratch?: (path: string) => Promise<void>;
}

function effectiveCliId(cliId: CliId): CliId {
  // Codex App is a transport around the same local Codex installation. A
  // background distillation turn uses Codex's native ephemeral exec surface,
  // never the main app-server thread.
  return cliId === 'codex-app' ? 'codex' : cliId;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 1_000) throw new TopicGroupMemoryLlmError('invalid_input');
  return Math.min(Math.floor(value), 10 * 60_000);
}

function isolatedCliEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(extra ?? {}) };
  // Distillation needs the CLI/provider environment, not IM/session authority.
  // Strip every Botmux/Lark capability and common unrelated source-control
  // credential before the subprocess starts.
  for (const key of Object.keys(env)) {
    if (
      /^BOTMUX_/u.test(key)
      || /^(?:LARK|FEISHU)_/u.test(key)
      || key === 'SESSION_DATA_DIR'
      || key === 'GITHUB_TOKEN'
      || key === 'GH_TOKEN'
    ) delete env[key];
  }
  delete env.CLAUDECODE;
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  return env;
}

function readPrivateOutputFile(path: string): string {
  let info;
  try { info = lstatSync(path); } catch { throw new TopicGroupMemoryLlmError('invalid_output'); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_RESULT_BYTES) {
    throw new TopicGroupMemoryLlmError('invalid_output');
  }
  return '';
}

async function structuredResultFromInvocation(
  invocation: TopicGroupMemoryCliInvocation,
  stdout: string,
): Promise<string> {
  if (invocation.outputMode === 'output-file') {
    readPrivateOutputFile(invocation.outputPath);
    const raw = await readFile(invocation.outputPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESULT_BYTES) throw new TopicGroupMemoryLlmError('invalid_output');
    return raw;
  }
  if (Buffer.byteLength(stdout, 'utf8') > MAX_RESULT_BYTES) throw new TopicGroupMemoryLlmError('invalid_output');
  let envelope: unknown;
  try { envelope = JSON.parse(stdout); } catch { throw new TopicGroupMemoryLlmError('invalid_output'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TopicGroupMemoryLlmError('invalid_output');
  }
  const record = envelope as Record<string, unknown>;
  if (record.structured_output !== undefined) return JSON.stringify(record.structured_output);
  if (typeof record.result === 'string') return record.result;
  throw new TopicGroupMemoryLlmError('invalid_output');
}

async function invokeCliProcess(invocation: TopicGroupMemoryCliInvocation): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(invocation.bin, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const signal = (name: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, name);
        else child.kill(name);
      } catch { /* already gone */ }
    };
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (error?: TopicGroupMemoryLlmError, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(value ?? '');
    };
    const fail = (code: 'process_failed' | 'timeout'): void => {
      if (settled) return;
      timedOut = code === 'timeout';
      signal('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => signal('SIGKILL'), 2_000);
      killTimer.unref();
    };

    const timeout = setTimeout(() => fail('timeout'), invocation.timeoutMs);
    timeout.unref();

    child.on('error', () => finish(new TopicGroupMemoryLlmError('process_failed')));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail('process_failed');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) fail('process_failed');
    });
    child.on('close', (code) => {
      if (settled) return;
      if (timedOut) {
        finish(new TopicGroupMemoryLlmError('timeout'));
        return;
      }
      if (code !== 0 || stdoutBytes > MAX_STDOUT_BYTES || stderrBytes > MAX_STDERR_BYTES) {
        finish(new TopicGroupMemoryLlmError('process_failed'));
        return;
      }
      void structuredResultFromInvocation(invocation, Buffer.concat(stdout).toString('utf8'))
        .then(value => finish(undefined, value))
        .catch(() => finish(new TopicGroupMemoryLlmError('invalid_output')));
    });
    child.stdin.on('error', () => fail('process_failed'));
    child.stdin.end(invocation.stdin);
  });
}

export async function distillTopicGroupMemoryWithCli(
  input: TopicGroupMemoryLlmInput,
  context: TopicGroupMemoryCliContext,
  deps: TopicGroupMemoryCliDistillerDeps = {},
): Promise<TopicGroupMemoryLlmPatch> {
  // Build first so sensitive/invalid input fails before any temporary files or
  // subprocess exist.
  const prompt = buildTopicGroupMemoryDistillationPrompt(input);
  const systemPrompt = buildTopicGroupMemoryDistillationSystemPrompt();
  const cliId = effectiveCliId(context.cliId);
  const adapter = createCliAdapterSync(cliId, context.cliPathOverride);
  if (!adapter.buildIsolatedStructuredRun) throw new TopicGroupMemoryLlmError('unsupported_cli');

  const parent = deps.scratchParent ?? tmpdir();
  const scratchDir = await mkdtemp(join(parent, SCRATCH_PREFIX));
  await chmod(scratchDir, 0o700);
  const schemaPath = join(scratchDir, 'memory-patch.schema.json');
  const outputPath = join(scratchDir, 'memory-patch.json');
  try {
    await writeFile(schemaPath, `${JSON.stringify(TOPIC_GROUP_MEMORY_PATCH_SCHEMA)}\n`, { encoding: 'utf8', mode: 0o600 });
    const spec = adapter.buildIsolatedStructuredRun({
      schema: TOPIC_GROUP_MEMORY_PATCH_SCHEMA,
      schemaPath,
      outputPath,
      systemPrompt,
      model: context.model,
    });
    let bin = adapter.resolvedBin;
    let args = spec.args;
    if (context.wrapperCli?.trim()) {
      const launch = buildWrappedLaunch(context.wrapperCli, args, value => locateOnPath(value) ?? value, {
        ttadkModel: context.model,
      });
      if (!launch.bin) throw new TopicGroupMemoryLlmError('unsupported_cli');
      bin = launch.bin;
      args = launch.args;
    }
    const invocation: TopicGroupMemoryCliInvocation = {
      bin,
      args,
      cwd: scratchDir,
      env: isolatedCliEnv(context.env),
      stdin: `${systemPrompt}\n\n${prompt}`,
      outputMode: spec.outputMode,
      outputPath,
      timeoutMs: normalizeTimeout(deps.timeoutMs),
    };
    const raw = await (deps.invokeCli ?? invokeCliProcess)(invocation);
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_RESULT_BYTES) {
      throw new TopicGroupMemoryLlmError('invalid_output');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new TopicGroupMemoryLlmError('invalid_output'); }
    return parseTopicGroupMemoryLlmPatch(parsed);
  } finally {
    await (deps.removeScratch ?? ((path: string) => rm(path, { recursive: true, force: true })))(scratchDir);
  }
}
