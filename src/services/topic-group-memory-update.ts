import { randomUUID } from 'node:crypto';
import type { DaemonSession } from '../core/types.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';
import { distillTopicGroupMemoryLocal } from './topic-group-memory-local-compactor.js';
import {
  TopicGroupMemoryLlmError,
  type TopicGroupMemoryLlmPatch,
  type TopicGroupMemoryLlmResource,
} from './topic-group-memory-llm-distiller.js';
import {
  distillTopicGroupMemoryWithCli,
  type TopicGroupMemoryCliContext,
} from './topic-group-memory-cli-distiller.js';
import {
  distillTopicGroupMemoryWithHttp,
  resolveTopicGroupMemoryHttpContext,
  type TopicGroupMemoryHttpContext,
} from './topic-group-memory-http-distiller.js';
import type { ResolvedTopicGroupMemoryHttpLlmConfig } from './topic-group-memory-config.js';
import {
  cleanTopicGroupMemoryText,
  safeTopicGroupMemoryText,
  topicGroupMemoryTextKey,
} from './topic-group-memory-safety.js';
import { resolveTopicGroupMemoryScope, topicGroupMemoryScopeInputFromSession } from './topic-group-memory-scope.js';
import {
  mutateTopicGroupMemory,
  readTopicGroupMemory,
  type TopicGroupMemoryDoc,
  type TopicGroupMemoryFact,
  type TopicGroupMemoryResource,
} from './topic-group-memory-store.js';

export interface TopicGroupMemoryFinalInput {
  turnId: string;
  content: string;
  userPrompt?: string;
}

export type TopicGroupMemoryPatchSource = 'llm' | 'local';

export interface TopicGroupMemoryUpdatePatch {
  source: TopicGroupMemoryPatchSource;
  contributionSummary: string;
  summaryPatch: string;
  summaryReplacement?: string;
  facts: string[];
  decisions: string[];
  openQuestions: string[];
  resources: TopicGroupMemoryLlmResource[];
  obsoleteItems: string[];
  factConfidence: TopicGroupMemoryFact['confidence'];
}

export interface TopicGroupMemoryDistillResult {
  patch: TopicGroupMemoryUpdatePatch;
  provider?: string;
  fallbackReason?: string;
}

export interface TopicGroupMemoryUpdateDeps {
  distillWithCli?: (
    input: Parameters<typeof distillTopicGroupMemoryWithCli>[0],
    context: TopicGroupMemoryCliContext,
  ) => Promise<TopicGroupMemoryLlmPatch>;
  distillWithHttp?: (
    input: Parameters<typeof distillTopicGroupMemoryWithHttp>[0],
    context: TopicGroupMemoryHttpContext,
  ) => Promise<TopicGroupMemoryLlmPatch>;
  /** Test/ops seam. Production leaves LLM enabled and lets provider/runtime
   * failures fall back to the deterministic extractive compactor. */
  disableLlm?: boolean;
}

function uniqueSafe(values: string[], maxItems = 10): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const value of values) {
    const cleaned = safeTopicGroupMemoryText(value, 1_000);
    if (!cleaned) continue;
    const key = topicGroupMemoryTextKey(cleaned);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function contributionFromLlmPatch(patch: TopicGroupMemoryLlmPatch): string {
  const candidates = [
    patch.summaryPatch,
    ...patch.decisionsUpsert,
    ...patch.factsUpsert,
    ...patch.openQuestionsUpsert,
    ...patch.resourcesUpsert.map(resource => `${resource.title}: ${resource.url}`),
    patch.reason,
  ];
  for (const candidate of candidates) {
    const cleaned = safeTopicGroupMemoryText(candidate, 500);
    if (cleaned.length >= 8) return cleaned;
  }
  return '';
}

function llmPatchToUpdatePatch(patch: TopicGroupMemoryLlmPatch): TopicGroupMemoryUpdatePatch | null {
  if (!patch.shouldUpdate) return null;
  const summaryPatch = safeTopicGroupMemoryText(patch.summaryPatch, 2_000);
  const facts = uniqueSafe(patch.factsUpsert);
  const decisions = uniqueSafe(patch.decisionsUpsert);
  const openQuestions = uniqueSafe(patch.openQuestionsUpsert);
  const resources = patch.resourcesUpsert;
  const obsoleteItems = uniqueSafe(patch.obsoleteItems);
  if (!summaryPatch && !facts.length && !decisions.length && !openQuestions.length && !resources.length && !obsoleteItems.length) return null;
  const contributionSummary = contributionFromLlmPatch({
    ...patch,
    summaryPatch,
    factsUpsert: facts,
    decisionsUpsert: decisions,
    openQuestionsUpsert: openQuestions,
    resourcesUpsert: resources,
    obsoleteItems,
  });
  if (!contributionSummary) return null;
  return {
    source: 'llm',
    contributionSummary,
    summaryPatch,
    facts,
    decisions,
    openQuestions,
    resources,
    obsoleteItems,
    factConfidence: 'inferred',
  };
}

function localPatchToUpdatePatch(input: {
  oldMemory: TopicGroupMemoryDoc | null;
  finalOutput: string;
  userPrompt?: string;
}): TopicGroupMemoryUpdatePatch | null {
  const patch = distillTopicGroupMemoryLocal({
    oldMemory: input.oldMemory,
    finalOutput: input.finalOutput,
    userMessage: input.userPrompt,
  });
  if (!patch) return null;
  return {
    source: 'local',
    contributionSummary: patch.contributionSummary,
    summaryPatch: '',
    summaryReplacement: patch.summaryReplacement,
    facts: uniqueSafe(patch.facts),
    decisions: uniqueSafe(patch.decisions),
    openQuestions: uniqueSafe(patch.openQuestions),
    resources: patch.resources,
    obsoleteItems: uniqueSafe(patch.obsoleteItems),
    factConfidence: patch.factConfidence,
  };
}

function upsertResource(
  items: TopicGroupMemoryResource[],
  resource: TopicGroupMemoryLlmResource,
  create: () => TopicGroupMemoryResource,
  now: string,
): TopicGroupMemoryResource[] {
  const existing = items.find(item => item.url === resource.url);
  if (!existing) return [...items, create()];
  existing.kind = resource.kind;
  existing.title = resource.title;
  existing.description = resource.description || undefined;
  existing.updatedAt = now;
  return items;
}

function reasonCode(error: unknown): string {
  if (error instanceof TopicGroupMemoryLlmError) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

export async function distillTopicGroupMemoryPatchForFinal(
  input: {
    oldMemory: TopicGroupMemoryDoc | null;
    finalOutput: string;
    userPrompt?: string;
    cliContext?: TopicGroupMemoryCliContext;
    httpContext?: TopicGroupMemoryHttpContext | null;
  },
  deps: TopicGroupMemoryUpdateDeps = {},
): Promise<TopicGroupMemoryDistillResult | null> {
  if (!deps.disableLlm) {
    const llmInput = {
      oldMemory: input.oldMemory,
      userMessage: input.userPrompt,
      finalOutput: input.finalOutput,
    };
    const failures: string[] = [];
    if (input.httpContext) {
      try {
        const llmPatch = await (deps.distillWithHttp ?? distillTopicGroupMemoryWithHttp)(llmInput, input.httpContext);
        const patch = llmPatchToUpdatePatch(llmPatch);
        return patch ? { patch, provider: 'http' } : null;
      } catch (error) {
        failures.push(`http:${reasonCode(error)}`);
      }
    }
    if (input.cliContext) {
      try {
        const llmPatch = await (deps.distillWithCli ?? distillTopicGroupMemoryWithCli)(llmInput, input.cliContext);
        const patch = llmPatchToUpdatePatch(llmPatch);
        return patch ? { patch, provider: input.cliContext.cliId === 'codex-app' ? 'codex' : input.cliContext.cliId } : null;
      } catch (error) {
        const provider = input.cliContext.cliId === 'codex-app' ? 'codex' : input.cliContext.cliId;
        failures.push(`${provider}:${reasonCode(error)}`);
      }
    }
    const fallback = localPatchToUpdatePatch(input);
    const reason = failures.length ? failures.join(',') : 'no_provider';
    logger.warn(`[topic-group-memory-distill] llm distill failed reason=${reason} fallback=${fallback ? 'local' : 'none'}`);
    return fallback ? { patch: fallback, fallbackReason: reason } : null;
  }
  const fallback = localPatchToUpdatePatch(input);
  return fallback ? { patch: fallback } : null;
}

function upsertText<T extends { text: string }>(items: T[], text: string, create: () => T): T[] {
  const key = topicGroupMemoryTextKey(text);
  if (!key || items.some(item => topicGroupMemoryTextKey(item.text) === key)) return items;
  return [...items, create()];
}

function appendSummaryPatch(existing: string, patch: string, maxSummaryChars: number): string {
  const cleaned = cleanTopicGroupMemoryText(patch, 2_000);
  if (!cleaned) return existing;
  if (topicGroupMemoryTextKey(existing).includes(topicGroupMemoryTextKey(cleaned))) return existing;
  const merged = existing.trim() ? `${existing.trim()}\n\n${cleaned}` : cleaned;
  return merged.length > maxSummaryChars ? merged.slice(-maxSummaryChars).trim() : merged;
}

function removeObsoleteItems(doc: TopicGroupMemoryDoc, obsoleteItems: string[]): void {
  if (!obsoleteItems.length) return;
  const obsolete = new Set(obsoleteItems.map(topicGroupMemoryTextKey).filter(Boolean));
  if (!obsolete.size) return;
  doc.facts = doc.facts.filter(item => !obsolete.has(topicGroupMemoryTextKey(item.text)));
  doc.decisions = doc.decisions.filter(item => !obsolete.has(topicGroupMemoryTextKey(item.text)));
  doc.openQuestions = doc.openQuestions.filter(item => !obsolete.has(topicGroupMemoryTextKey(item.text)));
  doc.resources = doc.resources.filter(item => !obsolete.has(topicGroupMemoryTextKey(item.url)) && !obsolete.has(topicGroupMemoryTextKey(item.title)));
}

export function applyTopicGroupMemoryUpdatePatch(
  current: TopicGroupMemoryDoc,
  patch: TopicGroupMemoryUpdatePatch,
  meta: { turnId: string; sessionId: string; rootMessageId: string; now: string; maxSummaryChars: number },
): TopicGroupMemoryDoc | false {
  if (current.recentContributions.some(entry => entry.turnId === meta.turnId)) return false;
  removeObsoleteItems(current, patch.obsoleteItems);
  if (patch.summaryReplacement !== undefined) {
    current.summary = cleanTopicGroupMemoryText(patch.summaryReplacement, meta.maxSummaryChars);
  } else {
    current.summary = appendSummaryPatch(current.summary, patch.summaryPatch, meta.maxSummaryChars);
  }
  current.recentContributions.push({
    turnId: meta.turnId,
    sessionId: meta.sessionId,
    rootMessageId: meta.rootMessageId,
    summary: patch.contributionSummary,
    createdAt: meta.now,
  });
  for (const value of patch.facts) {
    current.facts = upsertText(current.facts, value, () => ({
      id: `fact_${randomUUID()}`,
      text: value,
      sourceRootMessageId: meta.rootMessageId,
      sourceSessionId: meta.sessionId,
      createdAt: meta.now,
      updatedAt: meta.now,
      confidence: patch.factConfidence,
    }));
  }
  for (const value of patch.decisions) {
    current.decisions = upsertText(current.decisions, value, () => ({
      id: `decision_${randomUUID()}`,
      text: value,
      sourceRootMessageId: meta.rootMessageId,
      sourceSessionId: meta.sessionId,
      createdAt: meta.now,
    }));
  }
  for (const value of patch.openQuestions) {
    current.openQuestions = upsertText(current.openQuestions, value, () => ({
      id: `question_${randomUUID()}`,
      text: value,
      sourceRootMessageId: meta.rootMessageId,
      sourceSessionId: meta.sessionId,
      createdAt: meta.now,
    }));
  }
  for (const resource of patch.resources) {
    current.resources = upsertResource(current.resources, resource, () => ({
      id: `resource_${randomUUID()}`,
      kind: resource.kind,
      title: resource.title,
      url: resource.url,
      ...(resource.description ? { description: resource.description } : {}),
      sourceRootMessageId: meta.rootMessageId,
      sourceSessionId: meta.sessionId,
      createdAt: meta.now,
      updatedAt: meta.now,
      confidence: patch.factConfidence,
    }), meta.now);
  }
  return current;
}

export async function maybeUpdateTopicGroupMemoryFromFinal(
  ds: DaemonSession,
  output: TopicGroupMemoryFinalInput,
  deps: TopicGroupMemoryUpdateDeps = {},
): Promise<void> {
  if (ds.session.status === 'closed') {
    logger.debug(`[topic-group-memory:${ds.larkAppId}:${ds.chatId}] update skipped reason=session_closed`);
    return;
  }
  if (ds.adoptedFrom) {
    logger.debug(`[topic-group-memory:${ds.larkAppId}:${ds.chatId}] update skipped reason=adopted_session`);
    return;
  }
  if (ds.session.vcMeetingReceiver) {
    logger.debug(`[topic-group-memory:${ds.larkAppId}:${ds.chatId}] update skipped reason=vc_meeting_receiver`);
    return;
  }
  const scope = await resolveTopicGroupMemoryScope(topicGroupMemoryScopeInputFromSession(ds), { purpose: 'update' });
  if (!scope.enabled) {
    logger.debug(`[topic-group-memory:${ds.larkAppId}:${ds.chatId}] update skipped reason=${scope.reason}`);
    return;
  }
  const oldMemory = await readTopicGroupMemory(scope.larkAppId, scope.chatId, {
    limits: { maxSummaryChars: scope.config.maxSummaryChars },
  });
  if (oldMemory?.recentContributions.some(entry => entry.turnId === output.turnId)) {
    logger.debug(`[topic-group-memory:${scope.key}] update skipped reason=duplicate_turn turn=${output.turnId.substring(0, 8)}`);
    return;
  }
  const botConfig = getBot(ds.larkAppId).config;
  const cliId = ds.session.cliId
    ?? (ds.initConfig?.cliId as TopicGroupMemoryCliContext['cliId'] | undefined)
    ?? botConfig.cliId;
  const cliContext: TopicGroupMemoryCliContext = {
    cliId,
    cliPathOverride: ds.session.cliPathOverride ?? ds.initConfig?.cliPathOverride ?? botConfig.cliPathOverride,
    wrapperCli: ds.session.wrapperCli ?? ds.initConfig?.wrapperCli ?? botConfig.wrapperCli,
    model: ds.session.model ?? ds.initConfig?.model ?? botConfig.model,
    env: ds.initConfig?.env ?? botConfig.env,
  };
  const result = await distillTopicGroupMemoryPatchForFinal({
    oldMemory,
    finalOutput: output.content,
    userPrompt: output.userPrompt,
    cliContext,
    httpContext: resolveTopicGroupMemoryHttpContext(scope.config.httpLlm as ResolvedTopicGroupMemoryHttpLlmConfig, {
      model: cliContext.model,
      env: cliContext.env,
    }),
  }, deps);
  if (!result) {
    logger.debug(`[topic-group-memory:${scope.key}] update skipped reason=no_reusable_content turn=${output.turnId.substring(0, 8)}`);
    return;
  }
  const now = new Date().toISOString();
  const doc = await mutateTopicGroupMemory(scope.larkAppId, scope.chatId, current => applyTopicGroupMemoryUpdatePatch(current, result.patch, {
    turnId: output.turnId,
    sessionId: ds.session.sessionId,
    rootMessageId: scope.rootMessageId,
    now,
    maxSummaryChars: scope.config.maxSummaryChars,
  }), { limits: { maxSummaryChars: scope.config.maxSummaryChars } });
  logger.info(
    `[topic-group-memory:${scope.key}] updated revision=${doc.revision} turn=${output.turnId.substring(0, 8)} mode=${result.patch.source}`
    + (result.provider ? ` provider=${result.provider}` : '')
    + (result.fallbackReason ? ` fallback=${result.fallbackReason}` : ''),
  );
}

export function scheduleTopicGroupMemoryUpdate(ds: DaemonSession, output: TopicGroupMemoryFinalInput): void {
  const snapshot: TopicGroupMemoryFinalInput = {
    ...output,
    userPrompt: output.userPrompt
      ?? ds.lastUserPrompt
      ?? ds.session.lastUserPrompt
      ?? ds.lastCodexAppInput?.text,
  };
  setTimeout(() => {
    void maybeUpdateTopicGroupMemoryFromFinal(ds, snapshot).catch(error => {
      logger.warn(`[topic-group-memory:${ds.larkAppId}:${ds.chatId}] final update failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 0);
}
