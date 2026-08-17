import {
  getBot,
  type TopicGroupMemoryConfig,
  type TopicGroupMemoryHttpLlmConfig,
  type TopicGroupMemoryTencentDbConfig,
} from '../bot-registry.js';

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
  provider: 'auto' | 'local' | 'tencentdb';
  injectMode: 'off' | 'summary' | 'summary-and-facts';
  updateMode: 'off' | 'manual' | 'auto';
  maxPromptChars: number;
  maxSummaryChars: number;
  httpLlm: ResolvedTopicGroupMemoryHttpLlmConfig;
  tencentdb: ResolvedTopicGroupMemoryTencentDbConfig;
}

export interface ResolvedTopicGroupMemoryTencentDbConfig {
  runtimeDir: string;
  endpoint: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  maxResults: number;
  includePersona: boolean;
  includeScenes: boolean;
  timeoutMs: number;
  panelUrl?: string;
}

export const DEFAULT_TOPIC_GROUP_MEMORY_CONFIG: ResolvedTopicGroupMemoryConfig = {
  enabled: false,
  provider: 'auto',
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
  tencentdb: {
    runtimeDir: '~/harness_ai/heavy_duty_tools/tencentdb-agent-memory-runtime',
    endpoint: 'http://127.0.0.1:8420',
    apiKey: 'local',
    serviceId: 'botmux-local',
    teamId: 'botmux-topic-{scopeHash}',
    agentId: 'botmux-{appHash}',
    userId: 'topic-group-shared',
    maxResults: 5,
    includePersona: true,
    includeScenes: true,
    timeoutMs: 10_000,
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

function normalizeTencentDbConfig(raw: unknown): TopicGroupMemoryTencentDbConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const out: TopicGroupMemoryTencentDbConfig = {};
  for (const key of ['runtimeDir', 'endpoint', 'apiKey', 'serviceId', 'teamId', 'agentId', 'userId', 'panelUrl'] as const) {
    if (typeof input[key] === 'string') out[key] = input[key].trim();
  }
  if (typeof input.maxResults === 'number' && Number.isInteger(input.maxResults) && input.maxResults > 0) {
    out.maxResults = Math.min(input.maxResults, 20);
  }
  if (typeof input.includePersona === 'boolean') out.includePersona = input.includePersona;
  if (typeof input.includeScenes === 'boolean') out.includeScenes = input.includeScenes;
  if (typeof input.timeoutMs === 'number' && Number.isInteger(input.timeoutMs) && input.timeoutMs > 0) {
    out.timeoutMs = Math.min(input.timeoutMs, 60_000);
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeTopicGroupMemoryConfig(raw: unknown): TopicGroupMemoryConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const out: TopicGroupMemoryConfig = {};
  if (input.enabled === true) out.enabled = true;
  if (input.enabled === false) out.enabled = false;
  if (input.provider === 'auto' || input.provider === 'local' || input.provider === 'tencentdb') out.provider = input.provider;
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
  const tencentdb = normalizeTencentDbConfig(input.tencentdb);
  if (tencentdb) out.tencentdb = tencentdb;
  return Object.keys(out).length ? out : undefined;
}

export function resolveTopicGroupMemoryConfig(raw: TopicGroupMemoryConfig | undefined): ResolvedTopicGroupMemoryConfig {
  const positiveInt = (value: unknown, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  };
  const httpRaw = raw?.httpLlm;
  const tencentRaw = raw?.tencentdb;
  return {
    enabled: raw?.enabled === true,
    provider: raw?.provider === 'local' || raw?.provider === 'tencentdb' ? raw.provider : 'auto',
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
    tencentdb: {
      runtimeDir: typeof tencentRaw?.runtimeDir === 'string' && tencentRaw.runtimeDir.trim()
        ? tencentRaw.runtimeDir.trim()
        : DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.tencentdb.runtimeDir,
      endpoint: typeof tencentRaw?.endpoint === 'string' && tencentRaw.endpoint.trim()
        ? tencentRaw.endpoint.trim().replace(/\/+$/, '')
        : DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.tencentdb.endpoint,
      apiKey: typeof tencentRaw?.apiKey === 'string' && tencentRaw.apiKey.trim()
        ? tencentRaw.apiKey.trim()
        : DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.tencentdb.apiKey,
      serviceId: typeof tencentRaw?.serviceId === 'string' && tencentRaw.serviceId.trim()
        ? tencentRaw.serviceId.trim()
        : DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.tencentdb.serviceId,
      teamId: typeof tencentRaw?.teamId === 'string' && tencentRaw.teamId.trim()
        ? tencentRaw.teamId.trim()
        : DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.tencentdb.teamId,
      agentId: typeof tencentRaw?.agentId === 'string' && tencentRaw.agentId.trim()
        ? tencentRaw.agentId.trim()
        : DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.tencentdb.agentId,
      userId: typeof tencentRaw?.userId === 'string' && tencentRaw.userId.trim()
        ? tencentRaw.userId.trim()
        : DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.tencentdb.userId,
      maxResults: positiveInt(tencentRaw?.maxResults, DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.tencentdb.maxResults, 1, 20),
      includePersona: tencentRaw?.includePersona !== false,
      includeScenes: tencentRaw?.includeScenes !== false,
      timeoutMs: positiveInt(tencentRaw?.timeoutMs, DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.tencentdb.timeoutMs, 1_000, 60_000),
      ...(typeof tencentRaw?.panelUrl === 'string' && tencentRaw.panelUrl.trim()
        ? { panelUrl: tencentRaw.panelUrl.trim().replace(/\/+$/, '') }
        : {}),
    },
  };
}

export function getBotTopicGroupMemoryConfig(larkAppId: string): ResolvedTopicGroupMemoryConfig {
  try {
    return resolveTopicGroupMemoryConfig(getBot(larkAppId).config.topicGroupMemory);
  } catch {
    return {
      ...DEFAULT_TOPIC_GROUP_MEMORY_CONFIG,
      httpLlm: { ...DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.httpLlm },
      tencentdb: { ...DEFAULT_TOPIC_GROUP_MEMORY_CONFIG.tencentdb },
    };
  }
}
