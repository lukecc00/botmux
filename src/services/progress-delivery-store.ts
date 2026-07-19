/**
 * Durable outbox for model-authored progress cards.
 *
 * Codex commentary is emitted by a worker only once.  Persist it before the
 * daemon calls Lark so a daemon restart or a transient provider failure cannot
 * turn that one-shot IPC into a permanently missing card.  The provider UUID
 * is derived from the transcript UUID, making the small "Lark accepted, daemon
 * crashed before unlink" window idempotent as well.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface ProgressDeliveryRecord {
  version: 1;
  sessionId: string;
  turnId: string;
  transcriptUuid: string;
  content: string;
  dispatchAttempt?: number;
  /** Monotonic wall-clock-derived order. Keeps multiple cards from one turn in
   * model emission order, including after a daemon restart. */
  order: number;
}

let lastOrder = 0;

function nextOrder(): number {
  // Date.now()*1000 remains below Number.MAX_SAFE_INTEGER for centuries and
  // gives each daemon process 1000 ordered slots per millisecond.
  lastOrder = Math.max(Date.now() * 1000, lastOrder + 1);
  return lastOrder;
}

function recordKey(sessionId: string, transcriptUuid: string): string {
  return createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(transcriptUuid)
    .digest('hex');
}

function sessionDir(dataDir: string, sessionId: string): string {
  const sessionKey = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return join(dataDir, 'progress-outbox', sessionKey);
}

function recordPath(dataDir: string, sessionId: string, transcriptUuid: string): string {
  return join(sessionDir(dataDir, sessionId), `${recordKey(sessionId, transcriptUuid)}.json`);
}

function isRecord(value: unknown, expectedSessionId?: string): value is ProgressDeliveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1
    && typeof v.sessionId === 'string'
    && (!expectedSessionId || v.sessionId === expectedSessionId)
    && typeof v.turnId === 'string'
    && typeof v.transcriptUuid === 'string'
    && typeof v.content === 'string'
    && typeof v.order === 'number'
    && Number.isSafeInteger(v.order)
    && (v.dispatchAttempt === undefined
      || (typeof v.dispatchAttempt === 'number' && Number.isInteger(v.dispatchAttempt)));
}

/** Stable Lark request UUID (<=50 chars, provider-deduped for one hour). */
export function progressProviderUuid(sessionId: string, transcriptUuid: string): string {
  return `bmxp_${recordKey(sessionId, transcriptUuid).slice(0, 40)}`;
}

/** Stage once. A duplicate worker IPC reuses the original record/order. */
export function stageProgressDelivery(
  dataDir: string,
  input: Omit<ProgressDeliveryRecord, 'version' | 'order'>,
): ProgressDeliveryRecord {
  const path = recordPath(dataDir, input.sessionId, input.transcriptUuid);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (isRecord(parsed, input.sessionId)) return parsed;
    } catch { /* replace a corrupt entry with the authoritative IPC payload */ }
  }
  const record: ProgressDeliveryRecord = { version: 1, ...input, order: nextOrder() };
  mkdirSync(sessionDir(dataDir, input.sessionId), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export function listProgressDeliveries(dataDir: string, sessionId: string): ProgressDeliveryRecord[] {
  const dir = sessionDir(dataDir, sessionId);
  if (!existsSync(dir)) return [];
  const records: ProgressDeliveryRecord[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (isRecord(parsed, sessionId)) records.push(parsed);
    } catch { /* a damaged sidecar cannot authorize a Lark send */ }
  }
  return records.sort((a, b) => a.order - b.order || a.transcriptUuid.localeCompare(b.transcriptUuid));
}

export function completeProgressDelivery(
  dataDir: string,
  sessionId: string,
  transcriptUuid: string,
): void {
  try { rmSync(recordPath(dataDir, sessionId, transcriptUuid), { force: true }); } catch { /* retry on next replay */ }
}

export function discardProgressDeliveries(dataDir: string, sessionId: string): void {
  try { rmSync(sessionDir(dataDir, sessionId), { recursive: true, force: true }); } catch { /* best effort */ }
}
