import { getBot, type TopicGroupMemoryConfig, type TopicGroupMemoryHttpLlmConfig } from '../bot-registry.js';

export interface ResolvedTopicGroupMemoryHttpLlmConfig {
  enabled: boolean;
  autoDiscoverCodex: boolean;
  baseUrl?: string;
  model?: string;
  api: 'auto' | 'responses' | 'chat-completions';
  timeoutMs: number;
}

export interface ResolvedTopicGroupMemoryConfig {
  enabled: boolean;
  injectMode: 'off' | 'summary' | 'summary-and-facts';
  updateMode: 'off' | 'manual' | 'auto';
  maxPromptChars: number;
  maxSummaryChars: number;
  httpLlm: ResolvedTopicGroupMemoryHttpLlmConfig;
}

export const DEFAULT_TOPIC_GROUP_MEMORY_CONFIG: ResolvedTopicGroupMemoryConfig = {
  enabled: false,
  injectMode: 'summary',
  updateMode: 'auto',
  maxPromptChars: 8_000,
  maxSummaryChars: 10_000,
  httpLlm: {
    enabled: true,
    autoDiscoverCodex: true,
    api: 'auto',
    timeoutMs: 60_000,
  },
};

function normalizeHttpLlmConfig(raw: unknown): TopicGroupMemoryHttpLlmConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const out: TopicGroupMemoryHttpLlmConfig = {};
  if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
  if (typeof input.autoDiscoverCodex === 'boolean') out.autoDiscoverCodex = input.autoDiscoverCodex;
  if (typeof input.baseUrl === 'string' && input.baseUrl.trim()) out.baseUrl = input.baseUrl.trim();
  if (typeof input.model === 'string' && input.model.trim()) out.model = input.model.trim();
  if (input.api === 'auto' || input.api === 'responses' || input.api === 'chat-completions') out.api = input.api;
  if (typeof input.timeoutMs === 'number' && Number.isInteger(input.timeoutMs) && input.timeoutMs > 0) {
    out.timeoutMs = Math.min(input.timeoutMs, 300_000);
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeTopicGroupMemoryConfig(raw: unknown): TopicGroupMemoryConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const out: TopicGroupMemoryConfig = {};
  if (input.enabled === true) out.enabled = true;
  if (input.enabled === false) out.enabled = false;
  if (input.injectMode === 'off' || input.injectMode === 'summary' || input.injectMode === 'summary-and-facts') {
    out.injectMode = input.injectMode;
  }
  if (input.updateMode === 'off' || input.updateMode === 'manual' || input.updateMode === 'auto') {
    out.updateMode = input.updateMode;
  }
  if (typeof input.maxPromptChars === 'number' && Number.isInteger(input.maxPromptChars) && input.maxPromptChars > 0) {
    out.maxPromptChars = Math.min(input.maxPromptChars, 8_000);
  }
  if (typeof input.maxSummaryChars === 'number' && Number.isInteger(input.maxSummaryChars) && input.maxSummaryChars > 0) {
    out.maxSummaryChars = Math.min(input.maxSummaryChars, 10_000);
  }
  const httpLlm = normalizeHttpLlmConfig(input.httpLlm);
  if (httpLlm) out.httpLlm = httpLlm;
  return Object.keys(out).length ? out : undefined;
}

export function resolveTopicGroupMemoryConfig(raw: TopicGroupMemoryConfig | undefined): ResolvedTopicGroupMemoryConfig {
  const positiveInt = (value: unknown, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  };
  const httpRaw = raw?.httpLlm;
  return {
    enabled: raw?.enabled === true,
    injectMode: raw?.injectMode === 'off' || raw?.injectMode === 'summary-and-facts' ? raw.injectMode : 'summary',
    updateMode: raw?.updateMode === 'off' || raw?.updateMode === 'manual' ? raw.updateMode : 'auto',
    maxPromptChars: positiveInt(raw?.maxPromptChars, DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.maxPromptChars, 500, 8_000),
    maxSummaryChars: positiveInt(raw?.maxSummaryChars, DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.maxSummaryChars, 500, 10_000),
    httpLlm: {
      enabled: httpRaw?.enabled !== false,
      autoDiscoverCodex: httpRaw?.autoDiscoverCodex !== false,
      ...(typeof httpRaw?.baseUrl === 'string' && httpRaw.baseUrl.trim() ? { baseUrl: httpRaw.baseUrl.trim() } : {}),
      ...(typeof httpRaw?.model === 'string' && httpRaw.model.trim() ? { model: httpRaw.model.trim() } : {}),
      api: httpRaw?.api === 'responses' || httpRaw?.api === 'chat-completions' ? httpRaw.api : 'auto',
      timeoutMs: positiveInt(httpRaw?.timeoutMs, 60_000, 1_000, 300_000),
    },
  };
}

export function getBotTopicGroupMemoryConfig(larkAppId: string): ResolvedTopicGroupMemoryConfig {
  try {
    return resolveTopicGroupMemoryConfig(getBot(larkAppId).config.topicGroupMemory);
  } catch {
    return { ...DEFAULT_TOPIC_GROUP_MEMORY_CONFIG, httpLlm: { ...DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.httpLlm } };
  }
}
