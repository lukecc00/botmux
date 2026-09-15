import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

export interface TencentDbCaptureLedgerEntry {
  turnId: string;
  capturedAt: string;
}

interface CaptureLedger {
  schemaVersion: 1;
  captured: TencentDbCaptureLedgerEntry[];
}

export interface TencentDbCaptureLedgerOptions {
  dataDir?: string;
  maxEntries?: number;
  now?: () => string;
}

export function tencentDbCaptureLedgerPath(scopeKey: string, options: TencentDbCaptureLedgerOptions = {}): string {
  const digest = createHash('sha256').update(scopeKey).digest('hex');
  return join(
    resolve(options.dataDir ?? resolveBotmuxDataDir()),
    'topic-group-memory-tencentdb-ledger',
    `${digest}.json`,
  );
}

async function readLedger(path: string): Promise<CaptureLedger> {
  try {
    const raw = JSON.parse(await fsp.readFile(path, 'utf8')) as Partial<CaptureLedger>;
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.captured)) return { schemaVersion: 1, captured: [] };
    return {
      schemaVersion: 1,
      captured: raw.captured.flatMap(entry => (
        entry && typeof entry.turnId === 'string' && entry.turnId && typeof entry.capturedAt === 'string'
          ? [{ turnId: entry.turnId, capturedAt: entry.capturedAt }]
          : []
      )),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, captured: [] };
    throw error;
  }
}

export async function readTencentDbCaptureLedger(
  scopeKey: string,
  options: TencentDbCaptureLedgerOptions = {},
): Promise<{ path: string; captured: TencentDbCaptureLedgerEntry[] }> {
  const path = tencentDbCaptureLedgerPath(scopeKey, options);
  const ledger = await readLedger(path);
  return { path, captured: ledger.captured };
}

export async function latestTencentDbCaptureForScopes(
  scopeKeys: readonly string[],
  options: TencentDbCaptureLedgerOptions = {},
): Promise<({ scopeKey: string; path: string } & TencentDbCaptureLedgerEntry) | null> {
  let latest: ({ scopeKey: string; path: string } & TencentDbCaptureLedgerEntry) | null = null;
  for (const scopeKey of scopeKeys) {
    const ledger = await readTencentDbCaptureLedger(scopeKey, options);
    for (const entry of ledger.captured) {
      if (!latest || (Date.parse(entry.capturedAt) || 0) > (Date.parse(latest.capturedAt) || 0)) {
        latest = { scopeKey, path: ledger.path, ...entry };
      }
    }
  }
  return latest;
}

/**
 * Serialize the provider request and record a turn only after MemoryCore has
 * acknowledged it. This prevents ordinary replay duplicates while preserving
 * retryability when a provider call fails. A timeout after remote acceptance
 * remains inherently at-least-once because the upstream API has no idempotency
 * key; the ledger deliberately prefers a possible duplicate over lost memory.
 */
export async function captureTencentDbTurnOnce<T>(
  scopeKey: string,
  turnId: string,
  capture: () => Promise<T>,
  options: TencentDbCaptureLedgerOptions = {},
): Promise<{ captured: boolean; result?: T }> {
  if (!turnId.trim()) throw new Error('tencentdb_capture_turn_id_required');
  const path = tencentDbCaptureLedgerPath(scopeKey, options);
  await fsp.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLock(path, async () => {
    const ledger = await readLedger(path);
    if (ledger.captured.some(entry => entry.turnId === turnId)) return { captured: false };
    const result = await capture();
    const maxEntries = Math.max(10, Math.min(options.maxEntries ?? 500, 5_000));
    ledger.captured.push({ turnId, capturedAt: options.now?.() ?? new Date().toISOString() });
    ledger.captured = ledger.captured.slice(-maxEntries);
    await atomicWriteFile(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    return { captured: true, result };
  });
}
