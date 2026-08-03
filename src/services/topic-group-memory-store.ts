/**
 * Durable per-bot, per-topic-group shared memory.
 *
 * The isolation key is exactly larkAppId + chatId. Every mutation is serialized
 * with the repository's cross-process file lock and published with atomic
 * rename, so concurrent topic completions cannot tear or silently overwrite the
 * JSON document.
 */
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import {
  containsTopicGroupMemorySensitiveText,
  safeTopicGroupMemoryUrl,
  topicGroupMemoryTextKey,
} from './topic-group-memory-safety.js';
import {
  compactTopicGroupMemoryLocalDoc,
  topicGroupMemorySemanticSimilarity,
} from './topic-group-memory-local-compactor.js';
import type {
  TopicGroupMemoryHttpContext,
  TopicGroupMemoryHttpDistillerDeps,
  TopicGroupMemoryLlmCompactDoc,
} from './topic-group-memory-http-distiller.js';

export type TopicGroupMemoryConfidence = 'confirmed' | 'inferred';
export type TopicGroupMemoryResourceKind =
  | 'prd'
  | 'experiment'
  | 'ppe'
  | 'config'
  | 'document'
  | 'design'
  | 'api'
  | 'repository'
  | 'dashboard'
  | 'other';

export const TOPIC_GROUP_MEMORY_RESOURCE_KINDS: readonly TopicGroupMemoryResourceKind[] = [
  'prd', 'experiment', 'ppe', 'config', 'document', 'design', 'api', 'repository', 'dashboard', 'other',
] as const;

export interface TopicGroupMemoryFact {
  id: string;
  text: string;
  sourceRootMessageId?: string;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  confidence: TopicGroupMemoryConfidence;
}

export interface TopicGroupMemoryDecision {
  id: string;
  text: string;
  sourceRootMessageId?: string;
  sourceSessionId?: string;
  createdAt: string;
}

export interface TopicGroupMemoryOpenQuestion {
  id: string;
  text: string;
  sourceRootMessageId?: string;
  sourceSessionId?: string;
  createdAt: string;
}

export interface TopicGroupMemoryContribution {
  turnId: string;
  sessionId: string;
  rootMessageId: string;
  summary: string;
  createdAt: string;
}

export interface TopicGroupMemoryResource {
  id: string;
  kind: TopicGroupMemoryResourceKind;
  title: string;
  url: string;
  description?: string;
  sourceRootMessageId?: string;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  confidence: TopicGroupMemoryConfidence;
}

export interface TopicGroupMemoryDoc {
  schemaVersion: 1;
  larkAppId: string;
  chatId: string;
  chatMode: 'topic';
  enabled: true;
  updatedAt: string;
  revision: number;
  summary: string;
  facts: TopicGroupMemoryFact[];
  decisions: TopicGroupMemoryDecision[];
  openQuestions: TopicGroupMemoryOpenQuestion[];
  resources: TopicGroupMemoryResource[];
  recentContributions: TopicGroupMemoryContribution[];
}

export interface TopicGroupMemoryLimits {
  maxSummaryChars?: number;
  maxFacts?: number;
  maxDecisions?: number;
  maxOpenQuestions?: number;
  maxResources?: number;
  maxRecentContributions?: number;
  maxItemChars?: number;
}

export interface TopicGroupMemoryStoreOptions {
  dataDir?: string;
  limits?: TopicGroupMemoryLimits;
  httpContext?: TopicGroupMemoryHttpContext | null;
  compactWithHttp?: (
    doc: TopicGroupMemoryDoc,
    context: TopicGroupMemoryHttpContext,
    deps?: TopicGroupMemoryHttpDistillerDeps,
  ) => Promise<TopicGroupMemoryLlmCompactDoc>;
  httpDeps?: TopicGroupMemoryHttpDistillerDeps;
}

export interface TopicGroupMemoryStats {
  larkAppId: string;
  chatId: string;
  path: string;
  exists: boolean;
  hasContent: boolean;
  revision: number | null;
  updatedAt: string | null;
  sizeBytes: number;
  summaryChars: number;
  facts: number;
  decisions: number;
  openQuestions: number;
  resources: number;
  recentContributions: number;
  error?: string;
}

export interface TopicGroupMemoryCompactResult {
  compacted: boolean;
  source?: 'http' | 'local';
  fallbackReason?: string;
  doc: TopicGroupMemoryDoc | null;
  stats: TopicGroupMemoryStats;
}

export interface TopicGroupMemoryClearByChatResult {
  larkAppId: string;
  chatId: string;
  path: string;
  cleared: boolean;
  error?: string;
}

export type TopicGroupMemoryUpdateResult =
  | { ok: true; doc: TopicGroupMemoryDoc }
  | { ok: false; reason: 'revision_mismatch'; doc: TopicGroupMemoryDoc | null };

export interface TopicGroupMemoryEditableTextEntry {
  id: string;
  text: string;
}

export interface TopicGroupMemoryEditableResource {
  id: string;
  kind: TopicGroupMemoryResourceKind;
  title: string;
  url: string;
  description?: string;
}

/** User-editable memory content. Source metadata and recent-contribution
 * de-duplication records are intentionally excluded and preserved by the store. */
export interface TopicGroupMemoryEditableContent {
  summary: string;
  facts: TopicGroupMemoryEditableTextEntry[];
  decisions: TopicGroupMemoryEditableTextEntry[];
  openQuestions: TopicGroupMemoryEditableTextEntry[];
  resources: TopicGroupMemoryEditableResource[];
}

export type TopicGroupMemoryManualUpdateResult = TopicGroupMemoryUpdateResult
  | { ok: false; reason: 'invalid_content'; error: string; doc: TopicGroupMemoryDoc | null };

export const TOPIC_GROUP_MEMORY_DEFAULT_LIMITS: Readonly<Required<TopicGroupMemoryLimits>> = {
  maxSummaryChars: 10_000,
  maxFacts: 100,
  maxDecisions: 100,
  maxOpenQuestions: 50,
  maxResources: 100,
  maxRecentContributions: 50,
  maxItemChars: 1_000,
};

function safeSegment(value: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error(`invalid_topic_group_memory_${name}`);
  }
  return value;
}

function memoryBaseDir(dataDir?: string): string {
  return join(resolve(dataDir ?? resolveBotmuxDataDir()), 'topic-group-memory');
}

export function topicGroupMemoryPath(
  larkAppId: string,
  chatId: string,
  options: TopicGroupMemoryStoreOptions = {},
): string {
  return join(
    memoryBaseDir(options.dataDir),
    safeSegment(larkAppId, 'lark_app_id'),
    `${safeSegment(chatId, 'chat_id')}.json`,
  );
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validIso(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function normalizeDoc(
  raw: unknown,
  larkAppId: string,
  chatId: string,
  options: TopicGroupMemoryStoreOptions,
): TopicGroupMemoryDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, any>;
  if (input.schemaVersion !== 1) return null;
  if (input.larkAppId !== larkAppId || input.chatId !== chatId) return null;
  const limits = { ...TOPIC_GROUP_MEMORY_DEFAULT_LIMITS, ...options.limits };
  const now = new Date().toISOString();
  const mapFacts = Array.isArray(input.facts) ? input.facts : [];
  const mapDecisions = Array.isArray(input.decisions) ? input.decisions : [];
  const mapQuestions = Array.isArray(input.openQuestions) ? input.openQuestions : [];
  const mapResources = Array.isArray(input.resources) ? input.resources : [];
  const mapContributions = Array.isArray(input.recentContributions) ? input.recentContributions : [];
  return trimTopicGroupMemory({
    schemaVersion: 1,
    larkAppId,
    chatId,
    chatMode: 'topic',
    enabled: true,
    updatedAt: validIso(input.updatedAt, now),
    revision: Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    summary: text(input.summary, limits.maxSummaryChars),
    facts: mapFacts.map((entry: any): TopicGroupMemoryFact | null => {
      const body = text(entry?.text, limits.maxItemChars);
      if (!body) return null;
      const createdAt = validIso(entry?.createdAt, now);
      return {
        id: text(entry?.id, 160) || `fact_${randomUUID()}`,
        text: body,
        ...(text(entry?.sourceRootMessageId, 160) ? { sourceRootMessageId: text(entry.sourceRootMessageId, 160) } : {}),
        ...(text(entry?.sourceSessionId, 160) ? { sourceSessionId: text(entry.sourceSessionId, 160) } : {}),
        createdAt,
        updatedAt: validIso(entry?.updatedAt, createdAt),
        confidence: entry?.confidence === 'inferred' ? 'inferred' : 'confirmed',
      };
    }).filter((entry: TopicGroupMemoryFact | null): entry is TopicGroupMemoryFact => !!entry),
    decisions: mapDecisions.map((entry: any): TopicGroupMemoryDecision | null => {
      const body = text(entry?.text, limits.maxItemChars);
      if (!body) return null;
      return {
        id: text(entry?.id, 160) || `decision_${randomUUID()}`,
        text: body,
        ...(text(entry?.sourceRootMessageId, 160) ? { sourceRootMessageId: text(entry.sourceRootMessageId, 160) } : {}),
        ...(text(entry?.sourceSessionId, 160) ? { sourceSessionId: text(entry.sourceSessionId, 160) } : {}),
        createdAt: validIso(entry?.createdAt, now),
      };
    }).filter((entry: TopicGroupMemoryDecision | null): entry is TopicGroupMemoryDecision => !!entry),
    openQuestions: mapQuestions.map((entry: any): TopicGroupMemoryOpenQuestion | null => {
      const body = text(entry?.text, limits.maxItemChars);
      if (!body) return null;
      return {
        id: text(entry?.id, 160) || `question_${randomUUID()}`,
        text: body,
        ...(text(entry?.sourceRootMessageId, 160) ? { sourceRootMessageId: text(entry.sourceRootMessageId, 160) } : {}),
        ...(text(entry?.sourceSessionId, 160) ? { sourceSessionId: text(entry.sourceSessionId, 160) } : {}),
        createdAt: validIso(entry?.createdAt, now),
      };
    }).filter((entry: TopicGroupMemoryOpenQuestion | null): entry is TopicGroupMemoryOpenQuestion => !!entry),
    resources: mapResources.map((entry: any): TopicGroupMemoryResource | null => {
      const url = safeTopicGroupMemoryUrl(text(entry?.url, 2_048));
      const title = text(entry?.title, 300);
      if (!url || !title) return null;
      const createdAt = validIso(entry?.createdAt, now);
      const kind = TOPIC_GROUP_MEMORY_RESOURCE_KINDS.includes(entry?.kind)
        ? entry.kind as TopicGroupMemoryResourceKind
        : 'other';
      const description = text(entry?.description, limits.maxItemChars);
      return {
        id: text(entry?.id, 160) || `resource_${randomUUID()}`,
        kind,
        title,
        url,
        ...(description ? { description } : {}),
        ...(text(entry?.sourceRootMessageId, 160) ? { sourceRootMessageId: text(entry.sourceRootMessageId, 160) } : {}),
        ...(text(entry?.sourceSessionId, 160) ? { sourceSessionId: text(entry.sourceSessionId, 160) } : {}),
        createdAt,
        updatedAt: validIso(entry?.updatedAt, createdAt),
        confidence: entry?.confidence === 'inferred' ? 'inferred' : 'confirmed',
      };
    }).filter((entry: TopicGroupMemoryResource | null): entry is TopicGroupMemoryResource => !!entry),
    recentContributions: mapContributions.map((entry: any): TopicGroupMemoryContribution | null => {
      const summary = text(entry?.summary, limits.maxItemChars);
      const turnId = text(entry?.turnId, 160);
      const sessionId = text(entry?.sessionId, 160);
      const rootMessageId = text(entry?.rootMessageId, 160);
      if (!summary || !turnId || !sessionId || !rootMessageId) return null;
      return { turnId, sessionId, rootMessageId, summary, createdAt: validIso(entry?.createdAt, now) };
    }).filter((entry: TopicGroupMemoryContribution | null): entry is TopicGroupMemoryContribution => !!entry),
  }, options.limits);
}

export function createEmptyTopicGroupMemory(larkAppId: string, chatId: string): TopicGroupMemoryDoc {
  return {
    schemaVersion: 1,
    larkAppId,
    chatId,
    chatMode: 'topic',
    enabled: true,
    updatedAt: new Date().toISOString(),
    revision: 0,
    summary: '',
    facts: [],
    decisions: [],
    openQuestions: [],
    resources: [],
    recentContributions: [],
  };
}

export function trimTopicGroupMemory(
  doc: TopicGroupMemoryDoc,
  configured: TopicGroupMemoryLimits = {},
): TopicGroupMemoryDoc {
  const limits = { ...TOPIC_GROUP_MEMORY_DEFAULT_LIMITS, ...configured };
  const trimEntries = <T extends { text: string }>(entries: T[], max: number): T[] => entries
    .filter(entry => !!entry.text.trim() && !containsTopicGroupMemorySensitiveText(entry.text))
    .map(entry => ({ ...entry, text: entry.text.trim().slice(0, limits.maxItemChars) }))
    .slice(-max);
  const summary = doc.summary.trim().slice(0, limits.maxSummaryChars);
  return {
    ...doc,
    summary: containsTopicGroupMemorySensitiveText(summary) ? '' : summary,
    facts: trimEntries(doc.facts, limits.maxFacts),
    decisions: trimEntries(doc.decisions, limits.maxDecisions),
    openQuestions: trimEntries(doc.openQuestions, limits.maxOpenQuestions),
    resources: doc.resources
      .filter(entry => !!entry.title.trim()
        && !!safeTopicGroupMemoryUrl(entry.url)
        && !containsTopicGroupMemorySensitiveText(entry.title)
        && !containsTopicGroupMemorySensitiveText(entry.description ?? ''))
      .map(entry => ({
        ...entry,
        title: entry.title.trim().slice(0, 300),
        url: safeTopicGroupMemoryUrl(entry.url),
        ...(entry.description ? { description: entry.description.trim().slice(0, limits.maxItemChars) } : {}),
      }))
      .slice(-limits.maxResources),
    recentContributions: doc.recentContributions
      .filter(entry => !!entry.summary.trim() && !containsTopicGroupMemorySensitiveText(entry.summary))
      .map(entry => ({ ...entry, summary: entry.summary.trim().slice(0, limits.maxItemChars) }))
      .slice(-limits.maxRecentContributions),
  };
}

async function readUnlocked(
  larkAppId: string,
  chatId: string,
  options: TopicGroupMemoryStoreOptions,
): Promise<TopicGroupMemoryDoc | null> {
  const path = topicGroupMemoryPath(larkAppId, chatId, options);
  try {
    return normalizeDoc(JSON.parse(await fsp.readFile(path, 'utf8')), larkAppId, chatId, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readTopicGroupMemory(
  larkAppId: string,
  chatId: string,
  options: TopicGroupMemoryStoreOptions = {},
): Promise<TopicGroupMemoryDoc | null> {
  return readUnlocked(larkAppId, chatId, options);
}

export async function updateTopicGroupMemory(
  larkAppId: string,
  chatId: string,
  expectedRevision: number | null,
  updater: (current: TopicGroupMemoryDoc) => TopicGroupMemoryDoc | false | void,
  options: TopicGroupMemoryStoreOptions = {},
): Promise<TopicGroupMemoryUpdateResult> {
  const path = topicGroupMemoryPath(larkAppId, chatId, options);
  await fsp.mkdir(join(memoryBaseDir(options.dataDir), safeSegment(larkAppId, 'lark_app_id')), { recursive: true, mode: 0o700 });
  return withFileLock(path, async () => {
    const existing = await readUnlocked(larkAppId, chatId, options);
    if (expectedRevision !== null && (existing?.revision ?? 0) !== expectedRevision) {
      return { ok: false as const, reason: 'revision_mismatch' as const, doc: existing };
    }
    const base = existing ? structuredClone(existing) : createEmptyTopicGroupMemory(larkAppId, chatId);
    const updated = updater(base);
    if (updated === false && existing) return { ok: true as const, doc: existing };
    const changed = updated || base;
    const next = trimTopicGroupMemory({
      ...changed,
      schemaVersion: 1,
      larkAppId,
      chatId,
      chatMode: 'topic',
      enabled: true,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    }, options.limits);
    await atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return { ok: true as const, doc: next };
  });
}

/** Lock-serialized merge. Use this for append/upsert paths where retrying a
 * caller-side stale snapshot would add complexity without improving safety. */
export async function mutateTopicGroupMemory(
  larkAppId: string,
  chatId: string,
  updater: (current: TopicGroupMemoryDoc) => TopicGroupMemoryDoc | false | void,
  options: TopicGroupMemoryStoreOptions = {},
): Promise<TopicGroupMemoryDoc> {
  const result = await updateTopicGroupMemory(larkAppId, chatId, null, updater, options);
  if (!result.ok) throw new Error(result.reason);
  return result.doc;
}

function editableContentJson(doc: TopicGroupMemoryDoc): string {
  return JSON.stringify({
    summary: doc.summary,
    facts: doc.facts.map(({ id, text: body }) => ({ id, text: body })),
    decisions: doc.decisions.map(({ id, text: body }) => ({ id, text: body })),
    openQuestions: doc.openQuestions.map(({ id, text: body }) => ({ id, text: body })),
    resources: doc.resources.map(({ id, kind, title, url, description }) => ({
      id, kind, title, url, ...(description ? { description } : {}),
    })),
  });
}

function invalidEditableContent(
  error: string,
  doc: TopicGroupMemoryDoc | null,
): TopicGroupMemoryManualUpdateResult {
  return { ok: false, reason: 'invalid_content', error, doc };
}

/** Replace only the content exposed by the dashboard editor. Every id must
 * already exist in the current document; omitting an id deletes that specific
 * item. Source metadata and recentContributions survive unchanged. */
export async function replaceTopicGroupMemoryContent(
  larkAppId: string,
  chatId: string,
  expectedRevision: number,
  value: unknown,
  options: TopicGroupMemoryStoreOptions = {},
): Promise<TopicGroupMemoryManualUpdateResult> {
  const current = await readTopicGroupMemory(larkAppId, chatId, options);
  if (!current || current.revision !== expectedRevision) {
    return { ok: false, reason: 'revision_mismatch', doc: current };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidEditableContent('content_must_be_an_object', current);
  }
  const input = value as Record<string, unknown>;
  const limits = { ...TOPIC_GROUP_MEMORY_DEFAULT_LIMITS, ...options.limits };
  if (typeof input.summary !== 'string' || input.summary.length > limits.maxSummaryChars) {
    return invalidEditableContent('invalid_summary', current);
  }
  const summary = input.summary.trim();
  if (containsTopicGroupMemorySensitiveText(summary)) {
    return invalidEditableContent('sensitive_summary', current);
  }

  const parseTextEntries = <T extends { id: string; text: string }>(
    raw: unknown,
    existing: T[],
    section: string,
  ): TopicGroupMemoryEditableTextEntry[] | string => {
    if (!Array.isArray(raw)) return `invalid_${section}`;
    const byId = new Map(existing.map(entry => [entry.id, entry]));
    const seen = new Set<string>();
    const parsed: TopicGroupMemoryEditableTextEntry[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return `invalid_${section}_entry`;
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== 'string' || !byId.has(entry.id) || seen.has(entry.id)) return `invalid_${section}_id`;
      if (typeof entry.text !== 'string') return `invalid_${section}_text`;
      const body = entry.text.trim();
      if (!body || body.length > limits.maxItemChars) return `invalid_${section}_text`;
      if (containsTopicGroupMemorySensitiveText(body)) return `sensitive_${section}_text`;
      seen.add(entry.id);
      parsed.push({ id: entry.id, text: body });
    }
    return parsed;
  };

  const facts = parseTextEntries(input.facts, current.facts, 'facts');
  if (typeof facts === 'string') return invalidEditableContent(facts, current);
  const decisions = parseTextEntries(input.decisions, current.decisions, 'decisions');
  if (typeof decisions === 'string') return invalidEditableContent(decisions, current);
  const openQuestions = parseTextEntries(input.openQuestions, current.openQuestions, 'open_questions');
  if (typeof openQuestions === 'string') return invalidEditableContent(openQuestions, current);
  if (!Array.isArray(input.resources)) return invalidEditableContent('invalid_resources', current);

  const resourcesById = new Map(current.resources.map(entry => [entry.id, entry]));
  const seenResourceIds = new Set<string>();
  const resources: TopicGroupMemoryEditableResource[] = [];
  for (const item of input.resources) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return invalidEditableContent('invalid_resource_entry', current);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !resourcesById.has(entry.id) || seenResourceIds.has(entry.id)) {
      return invalidEditableContent('invalid_resource_id', current);
    }
    if (typeof entry.kind !== 'string' || !TOPIC_GROUP_MEMORY_RESOURCE_KINDS.includes(entry.kind as TopicGroupMemoryResourceKind)) {
      return invalidEditableContent('invalid_resource_kind', current);
    }
    if (typeof entry.title !== 'string' || typeof entry.url !== 'string'
      || (entry.description !== undefined && typeof entry.description !== 'string')) {
      return invalidEditableContent('invalid_resource_content', current);
    }
    const title = entry.title.trim();
    const description = typeof entry.description === 'string' ? entry.description.trim() : '';
    const url = safeTopicGroupMemoryUrl(entry.url);
    if (!title || title.length > 300 || !url || entry.url.length > 2_048 || description.length > limits.maxItemChars) {
      return invalidEditableContent('invalid_resource_content', current);
    }
    if (containsTopicGroupMemorySensitiveText(title) || containsTopicGroupMemorySensitiveText(description)) {
      return invalidEditableContent('sensitive_resource_content', current);
    }
    seenResourceIds.add(entry.id);
    resources.push({
      id: entry.id,
      kind: entry.kind as TopicGroupMemoryResourceKind,
      title,
      url,
      ...(description ? { description } : {}),
    });
  }

  return updateTopicGroupMemory(larkAppId, chatId, expectedRevision, doc => {
    const now = new Date().toISOString();
    const factById = new Map(doc.facts.map(entry => [entry.id, entry]));
    const decisionById = new Map(doc.decisions.map(entry => [entry.id, entry]));
    const questionById = new Map(doc.openQuestions.map(entry => [entry.id, entry]));
    const resourceById = new Map(doc.resources.map(entry => [entry.id, entry]));
    const next: TopicGroupMemoryDoc = {
      ...doc,
      summary,
      facts: facts.map(entry => {
        const old = factById.get(entry.id)!;
        return { ...old, text: entry.text, updatedAt: old.text === entry.text ? old.updatedAt : now };
      }),
      decisions: decisions.map(entry => ({ ...decisionById.get(entry.id)!, text: entry.text })),
      openQuestions: openQuestions.map(entry => ({ ...questionById.get(entry.id)!, text: entry.text })),
      resources: resources.map(entry => {
        const old = resourceById.get(entry.id)!;
        const changed = old.kind !== entry.kind || old.title !== entry.title
          || old.url !== entry.url || (old.description ?? '') !== (entry.description ?? '');
        const { description: _oldDescription, ...oldWithoutDescription } = old;
        return {
          ...oldWithoutDescription,
          ...entry,
          ...(entry.description ? { description: entry.description } : {}),
          updatedAt: changed ? now : old.updatedAt,
        };
      }),
    };
    return editableContentJson(next) === editableContentJson(doc) ? false : next;
  }, options);
}

export async function clearTopicGroupMemory(
  larkAppId: string,
  chatId: string,
  options: TopicGroupMemoryStoreOptions = {},
): Promise<boolean> {
  const path = topicGroupMemoryPath(larkAppId, chatId, options);
  await fsp.mkdir(join(memoryBaseDir(options.dataDir), safeSegment(larkAppId, 'lark_app_id')), { recursive: true, mode: 0o700 });
  return withFileLock(path, async () => {
    try {
      await fsp.unlink(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  });
}

/** Delete every bot partition for a dissolved topic group. This is used by the
 * dashboard group-disband flow: once the Lark chat no longer exists, the
 * per-bot topic-group memories for that chat must not linger in the global
 * maintenance table. Individual file errors are reported but do not stop other
 * bot partitions from being cleaned. */
export async function clearTopicGroupMemoriesForChat(
  chatId: string,
  options: TopicGroupMemoryStoreOptions = {},
): Promise<TopicGroupMemoryClearByChatResult[]> {
  const safeChatId = safeSegment(chatId, 'chat_id');
  const base = memoryBaseDir(options.dataDir);
  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const results: TopicGroupMemoryClearByChatResult[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9._-]+$/u.test(entry.name)) continue;
    const larkAppId = entry.name;
    const path = topicGroupMemoryPath(larkAppId, safeChatId, options);
    try {
      const cleared = await clearTopicGroupMemory(larkAppId, safeChatId, options);
      if (cleared) results.push({ larkAppId, chatId: safeChatId, path, cleared: true });
    } catch (error) {
      results.push({
        larkAppId,
        chatId: safeChatId,
        path,
        cleared: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** Delete every topic-group memory file in one bot partition. */
export async function clearAllTopicGroupMemories(
  larkAppId: string,
  options: TopicGroupMemoryStoreOptions = {},
): Promise<TopicGroupMemoryClearByChatResult[]> {
  const memories = await listTopicGroupMemories(larkAppId, options);
  return Promise.all(memories.map(async memory => {
    try {
      const cleared = await clearTopicGroupMemory(larkAppId, memory.chatId, options);
      return {
        larkAppId,
        chatId: memory.chatId,
        path: memory.path,
        cleared,
      };
    } catch (error) {
      return {
        larkAppId,
        chatId: memory.chatId,
        path: memory.path,
        cleared: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

export function topicGroupMemoryHasContent(doc: TopicGroupMemoryDoc | null | undefined): boolean {
  return !!doc && !!(
    doc.summary.trim()
    || doc.facts.length
    || doc.decisions.length
    || doc.openQuestions.length
    || doc.resources.length
    || doc.recentContributions.length
  );
}

function topicGroupMemoryStatsFromDoc(
  larkAppId: string,
  chatId: string,
  path: string,
  doc: TopicGroupMemoryDoc | null,
  sizeBytes: number,
  exists: boolean,
  error?: string,
): TopicGroupMemoryStats {
  return {
    larkAppId,
    chatId,
    path,
    exists,
    hasContent: topicGroupMemoryHasContent(doc),
    revision: doc?.revision ?? null,
    updatedAt: doc?.updatedAt ?? null,
    sizeBytes,
    summaryChars: doc?.summary.length ?? 0,
    facts: doc?.facts.length ?? 0,
    decisions: doc?.decisions.length ?? 0,
    openQuestions: doc?.openQuestions.length ?? 0,
    resources: doc?.resources.length ?? 0,
    recentContributions: doc?.recentContributions.length ?? 0,
    ...(error ? { error } : {}),
  };
}

export async function statTopicGroupMemory(
  larkAppId: string,
  chatId: string,
  options: TopicGroupMemoryStoreOptions = {},
): Promise<TopicGroupMemoryStats> {
  const path = topicGroupMemoryPath(larkAppId, chatId, options);
  let sizeBytes = 0;
  try {
    sizeBytes = (await fsp.stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return topicGroupMemoryStatsFromDoc(larkAppId, chatId, path, null, 0, false);
    }
    throw error;
  }
  try {
    const doc = await readTopicGroupMemory(larkAppId, chatId, options);
    return topicGroupMemoryStatsFromDoc(larkAppId, chatId, path, doc, sizeBytes, true);
  } catch (error) {
    return topicGroupMemoryStatsFromDoc(
      larkAppId,
      chatId,
      path,
      null,
      sizeBytes,
      true,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** List persisted memory documents. Supplying larkAppId is the normal bot
 * dashboard path; omitting it is useful for local CLI diagnostics. Corrupt
 * files remain visible with an `error` field instead of hiding the problem. */
export async function listTopicGroupMemories(
  larkAppId?: string,
  options: TopicGroupMemoryStoreOptions = {},
): Promise<TopicGroupMemoryStats[]> {
  const base = memoryBaseDir(options.dataDir);
  let appIds: string[];
  if (larkAppId) {
    appIds = [safeSegment(larkAppId, 'lark_app_id')];
  } else {
    try {
      appIds = (await fsp.readdir(base, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^[A-Za-z0-9._-]+$/u.test(entry.name))
        .map(entry => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  const out: TopicGroupMemoryStats[] = [];
  for (const appId of appIds) {
    const appDir = join(base, appId);
    let entries;
    try {
      entries = await fsp.readdir(appDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const chatId = entry.name.slice(0, -'.json'.length);
      if (!/^[A-Za-z0-9._-]+$/u.test(chatId)) continue;
      out.push(await statTopicGroupMemory(appId, chatId, options));
    }
  }
  return out.sort((a, b) => {
    const byUpdated = (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0);
    return byUpdated || a.larkAppId.localeCompare(b.larkAppId) || a.chatId.localeCompare(b.chatId);
  });
}

function keepLatestUnique<T>(entries: T[], keyOf: (entry: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const key = keyOf(entries[index]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.unshift(entries[index]);
  }
  return result;
}

function compactSummary(summary: string): string {
  return keepLatestUnique(
    summary.split(/\n{2,}/u).map(part => part.trim()).filter(Boolean),
    topicGroupMemoryTextKey,
  ).join('\n\n');
}

/** Deterministic, no-LLM semantic maintenance compaction. It folds paraphrases,
 * preserves newest source metadata, rebuilds an extractive summary, then
 * enforces the same hard limits used by every write. */
export function compactTopicGroupMemoryDoc(
  doc: TopicGroupMemoryDoc,
  configured: TopicGroupMemoryLimits = {},
): TopicGroupMemoryDoc {
  return trimTopicGroupMemory(compactTopicGroupMemoryLocalDoc({
    ...doc,
    summary: compactSummary(doc.summary),
    facts: keepLatestUnique(doc.facts, entry => topicGroupMemoryTextKey(entry.text)),
    decisions: keepLatestUnique(doc.decisions, entry => topicGroupMemoryTextKey(entry.text)),
    openQuestions: keepLatestUnique(doc.openQuestions, entry => topicGroupMemoryTextKey(entry.text)),
    resources: keepLatestUnique(doc.resources, entry => safeTopicGroupMemoryUrl(entry.url)),
    recentContributions: keepLatestUnique(doc.recentContributions, entry => entry.turnId.trim()),
  }), configured);
}

function memoryContentJson(doc: TopicGroupMemoryDoc): string {
  return JSON.stringify({
    summary: doc.summary,
    facts: doc.facts.map(item => ({
      id: item.id,
      text: item.text,
      sourceRootMessageId: item.sourceRootMessageId,
      sourceSessionId: item.sourceSessionId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      confidence: item.confidence,
    })),
    decisions: doc.decisions.map(item => ({
      id: item.id,
      text: item.text,
      sourceRootMessageId: item.sourceRootMessageId,
      sourceSessionId: item.sourceSessionId,
      createdAt: item.createdAt,
    })),
    openQuestions: doc.openQuestions.map(item => ({
      id: item.id,
      text: item.text,
      sourceRootMessageId: item.sourceRootMessageId,
      sourceSessionId: item.sourceSessionId,
      createdAt: item.createdAt,
    })),
    resources: doc.resources.map(item => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      url: item.url,
      description: item.description,
      sourceRootMessageId: item.sourceRootMessageId,
      sourceSessionId: item.sourceSessionId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      confidence: item.confidence,
    })),
    recentContributions: doc.recentContributions.map(item => ({
      turnId: item.turnId,
      sessionId: item.sessionId,
      rootMessageId: item.rootMessageId,
      summary: item.summary,
      createdAt: item.createdAt,
    })),
  });
}

function bestTextMatch<T extends { text: string }>(entries: T[], text: string): T | undefined {
  const key = topicGroupMemoryTextKey(text);
  const exact = entries.find(entry => topicGroupMemoryTextKey(entry.text) === key);
  if (exact) return exact;
  let best: { entry: T; score: number } | undefined;
  for (const entry of entries) {
    const score = topicGroupMemorySemanticSimilarity(entry.text, text);
    if (score >= 0.72 && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry;
}

function applyLlmCompactDoc(
  doc: TopicGroupMemoryDoc,
  compact: TopicGroupMemoryLlmCompactDoc,
  configured: TopicGroupMemoryLimits = {},
): TopicGroupMemoryDoc {
  const now = new Date().toISOString();
  const resourcesByUrl = new Map(doc.resources.map(resource => [safeTopicGroupMemoryUrl(resource.url), resource]));
  const materializeFact = (value: string): TopicGroupMemoryFact => {
    const existing = bestTextMatch(doc.facts, value);
    return existing
      ? { ...existing, text: value, updatedAt: topicGroupMemoryTextKey(existing.text) === topicGroupMemoryTextKey(value) ? existing.updatedAt : now }
      : { id: `fact_${randomUUID()}`, text: value, createdAt: now, updatedAt: now, confidence: 'inferred' };
  };
  const materializeDecision = (value: string): TopicGroupMemoryDecision => {
    const existing = bestTextMatch(doc.decisions, value);
    return existing ? { ...existing, text: value } : { id: `decision_${randomUUID()}`, text: value, createdAt: now };
  };
  const materializeQuestion = (value: string): TopicGroupMemoryOpenQuestion => {
    const existing = bestTextMatch(doc.openQuestions, value);
    return existing ? { ...existing, text: value } : { id: `question_${randomUUID()}`, text: value, createdAt: now };
  };
  const nextResources: TopicGroupMemoryResource[] = [];
  for (const resource of compact.resources) {
    const url = safeTopicGroupMemoryUrl(resource.url);
    const existing = resourcesByUrl.get(url);
    // Manual compaction is allowed to drop stale resources, but not to invent
    // new links that were never present in the existing shared-memory store.
    if (!url || !existing) continue;
    const resourceChanged = existing.kind !== resource.kind
      || existing.title !== resource.title
      || (existing.description ?? '') !== resource.description;
    const { description: _existingDescription, ...existingWithoutDescription } = existing;
    nextResources.push({
      ...existingWithoutDescription,
      kind: resource.kind,
      title: resource.title,
      ...(resource.description ? { description: resource.description } : {}),
      updatedAt: resourceChanged ? now : existing.updatedAt,
    });
  }
  return trimTopicGroupMemory({
    ...doc,
    summary: compact.summary,
    facts: compact.facts.map(materializeFact),
    decisions: compact.decisions.map(materializeDecision),
    openQuestions: compact.openQuestions.map(materializeQuestion),
    resources: keepLatestUnique(nextResources, entry => safeTopicGroupMemoryUrl(entry.url)),
    recentContributions: keepLatestUnique(doc.recentContributions, entry => entry.turnId.trim()),
  }, configured);
}

function compactFailureReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

export async function compactTopicGroupMemory(
  larkAppId: string,
  chatId: string,
  options: TopicGroupMemoryStoreOptions = {},
): Promise<TopicGroupMemoryCompactResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readTopicGroupMemory(larkAppId, chatId, options);
    if (!current) {
      return {
        compacted: false,
        doc: null,
        stats: await statTopicGroupMemory(larkAppId, chatId, options),
      };
    }
    let source: 'http' | 'local' = 'local';
    let fallbackReason: string | undefined;
    let compact = compactTopicGroupMemoryDoc(current, options.limits);
    if (options.httpContext && options.compactWithHttp) {
      try {
        const llmDoc = await options.compactWithHttp(current, options.httpContext, options.httpDeps);
        compact = applyLlmCompactDoc(current, llmDoc, options.limits);
        source = 'http';
      } catch (error) {
        fallbackReason = `http:${compactFailureReason(error)}`;
      }
    }
    let compacted = false;
    const result = await updateTopicGroupMemory(larkAppId, chatId, current.revision, doc => {
      if (memoryContentJson(compact) === memoryContentJson(doc)) return false;
      compacted = true;
      return compact;
    }, options);
    if (!result.ok) continue;
    return {
      compacted,
      source,
      ...(fallbackReason ? { fallbackReason } : {}),
      doc: result.doc,
      stats: await statTopicGroupMemory(larkAppId, chatId, options),
    };
  }
  throw new Error('topic_group_memory_compact_revision_conflict');
}
