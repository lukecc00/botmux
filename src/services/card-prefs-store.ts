/**
 * Per-bot card-behaviour preferences. Mirrors the brand-store / oncall-store
 * pattern: cross-process file lock + atomic write of bots.json, plus an
 * in-memory registry sync so the daemon's own card builders pick up the change
 * without a restart.
 *
 * Per-bot card and related session preferences:
 *   • usageDisplay              — where to show native Context / Token usage:
 *                                  'streaming' (default) = live streaming card
 *                                  body, 'footer' = ordinary reply-card footer,
 *                                  'off' = nowhere
 *   • disableStreamingCard      — suppress the live streaming session card
 *   • silentTurnReactions       — in card-off sessions, also drop the ✋→✅
 *                                  lightweight status reactions on the trigger
 *                                  message (only meaningful while the card is off)
 *   • writableTerminalLinkInCard — embed a directly-usable writable terminal
 *                                  link in the streaming card body
 *   • privateCard               — `/card` sends a private ephemeral snapshot
 *                                  (visible to the talk-grant audience) instead
 *                                  of the group-visible live card
 *   • thinkingCard              — stream the model's thinking process into a
 *                                  native Feishu CoT message during turns
 *                                  (bot-level master switch; per-chat opt-out
 *                                  via /cot off)
 *   • senderTag                 — inject the per-turn `<sender>` tag naming who
 *                                  spoke (default on; off drops per-message
 *                                  identity from the prompt)
 *   • regularGroupReplyMode     — per-bot DEFAULT session mode for regular
 *                                  groups: chat | chat-topic | new-topic | shared
 *                                  (see chat-reply-mode-store). Default 'chat'.
 */
import { rmwBotEntry } from './config-store.js';
import {
  getBot,
  normalizeUsageDisplay,
  DEFAULT_USAGE_DISPLAY,
  type ChatReplyMode,
  type TopicGroupMemoryConfig,
  type UsageDisplayMode,
} from '../bot-registry.js';
import { logger } from '../utils/logger.js';
import {
  resolveTopicGroupMemoryConfig,
  type ResolvedTopicGroupMemoryConfig,
} from './topic-group-memory-config.js';
import {
  notifyPinStreamingCardChanged,
  serializePinStreamingCardConfigChange,
} from './pin-streaming-card-change.js';

export interface BotCardPrefs {
  /** Where to show native Context / Token usage:
   *  'streaming' (default) = live streaming card body, 'footer' = ordinary
   *  reply-card footer, 'off' = nowhere. */
  usageDisplay: UsageDisplayMode;
  disableStreamingCard: boolean;
  pinStreamingCard: boolean;
  silentTurnReactions: boolean;
  /** Experimental Codex App presentation mode. Default false preserves the
   * legacy full-prompt UserMessage; true moves Botmux metadata to hidden
   * app-server context for newly dispatched turns. */
  codexAppCleanInput: boolean;
  writableTerminalLinkInCard: boolean;
  privateCard: boolean;
  /** Bot-level master switch for the native CoT (thinking process) message.
   *  Default TRUE (absent = on; only explicit false persists). Per-chat
   *  opt-out lives in noCotChats (`/cot off`), not here. */
  thinkingCard: boolean;
  /** Whether each forwarded turn carries a `<sender …/>` tag naming the speaker.
   *  Default TRUE (absent = on; only an explicit false persists), same
   *  convention as thinkingCard. Off also drops the cursor anti-echo note (it is
   *  gated on the tag) and costs two observability signals — see BotConfig.senderTag. */
  senderTag: boolean;
  /** When true, this bot's daemon watches host load/mem and DMs the owner on
   *  overload enter/recover edges. Machine-wide signal, so designate one bot;
   *  a shared episode lock de-dups if several have it on. Default false. */
  overloadAlert: boolean;
  /** bot@bot 同目录拉起: when a bot is @-ed into a chat where a sibling bot is
   *  already working, inherit that sibling's workingDir & skip the repo card.
   *  Default TRUE (unlike the others) — only an explicit false is persisted. */
  botToBotSameDir: boolean;
  /** 主动开工 — 场景①: auto-start when added to a new chat (see auto-start.ts). */
  autoStartOnGroupJoin: boolean;
  /** 主动开工 — 场景① optional pre-configured first-turn prompt ('' = none). */
  autoStartOnGroupJoinPrompt: string;
  /** 主动开工 — 场景① custom join seed message ('' = built-in i18n text). */
  autoStartOnGroupJoinSeed: string;
  /** 主动开工 — 场景②: auto-start on every new topic in a topic group. */
  autoStartOnNewTopic: boolean;
  /** Per-bot DEFAULT regular-group session mode (chat | chat-topic | new-topic | shared). */
  regularGroupReplyMode: ChatReplyMode;
  /** Per-bot 4-tier @-requirement policy for regular groups (default 'always'). */
  regularGroupMentionMode: 'always' | 'topic' | 'never' | 'ambient';
  /** 文档订阅新订阅默认评论触发范围（default 'mention-only'）。 */
  docSubscribeDefaultMode: 'mention-only' | 'all';
  /** Explicit /summary records a project-local summary.md when enabled. */
  summaryMemory: boolean;
  /** Target path for summary memory. Relative paths resolve against the current project root. */
  summaryMemoryPath: string;
  /** Shared MemoryCore-backed memory for independent sessions in one topic group. */
  topicGroupMemory: ResolvedTopicGroupMemoryConfig;
}

export type BotCardPrefsPatch = Omit<Partial<BotCardPrefs>, 'topicGroupMemory'> & {
  topicGroupMemory?: TopicGroupMemoryConfig;
};

/** Current card prefs for a bot (`usageDisplay` defaults to 'streaming';
 * `botToBotSameDir` defaults true; other booleans default false). */
export function getBotCardPrefs(larkAppId: string): BotCardPrefs {
  try {
    const c = getBot(larkAppId).config;
    const topicGroupMemory = resolveTopicGroupMemoryConfig(c.topicGroupMemory);
    return {
      usageDisplay: normalizeUsageDisplay(c),
      disableStreamingCard: c.disableStreamingCard === true,
      pinStreamingCard: c.pinStreamingCard === true,
      silentTurnReactions: c.silentTurnReactions === true,
      codexAppCleanInput: c.codexAppCleanInput === true,
      writableTerminalLinkInCard: c.writableTerminalLinkInCard === true,
      privateCard: c.privateCard === true,
      thinkingCard: c.thinkingCard !== false,
      senderTag: c.senderTag !== false,
      overloadAlert: c.overloadAlert === true,
      botToBotSameDir: c.botToBotSameDir !== false,
      autoStartOnGroupJoin: c.autoStartOnGroupJoin === true,
      autoStartOnGroupJoinPrompt: typeof c.autoStartOnGroupJoinPrompt === 'string' ? c.autoStartOnGroupJoinPrompt : '',
      autoStartOnGroupJoinSeed: typeof c.autoStartOnGroupJoinSeed === 'string' ? c.autoStartOnGroupJoinSeed : '',
      autoStartOnNewTopic: c.autoStartOnNewTopic === true,
      regularGroupReplyMode: c.regularGroupReplyMode ?? 'chat-topic',
      regularGroupMentionMode: c.regularGroupMentionMode === 'topic' || c.regularGroupMentionMode === 'never' || c.regularGroupMentionMode === 'ambient'
        ? c.regularGroupMentionMode : 'always',
      docSubscribeDefaultMode: c.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only',
      summaryMemory: c.summaryMemory === true,
      summaryMemoryPath: typeof c.summaryMemoryPath === 'string' && c.summaryMemoryPath.trim() ? c.summaryMemoryPath.trim() : 'summary.md',
      topicGroupMemory,
    };
  } catch {
    return {
      usageDisplay: DEFAULT_USAGE_DISPLAY,
      disableStreamingCard: false,
      pinStreamingCard: false,
      silentTurnReactions: false,
      codexAppCleanInput: false,
      writableTerminalLinkInCard: false,
      privateCard: false,
      thinkingCard: true,
      senderTag: true,
      overloadAlert: false,
      botToBotSameDir: true,
      autoStartOnGroupJoin: false,
      autoStartOnGroupJoinPrompt: '',
      autoStartOnGroupJoinSeed: '',
      autoStartOnNewTopic: false,
      regularGroupReplyMode: 'chat-topic',
      regularGroupMentionMode: 'always',
      docSubscribeDefaultMode: 'mention-only',
      summaryMemory: false,
      summaryMemoryPath: 'summary.md',
      topicGroupMemory: resolveTopicGroupMemoryConfig(undefined),
    };
  }
}

/**
 * Persist a partial card-prefs change. Only the keys present in `patch` are
 * touched; a `false` value removes the key (keeps bots.json tidy — absent means
 * the default). Returns the full resolved prefs after the write.
 */
export async function updateBotCardPrefs(
  larkAppId: string,
  patch: BotCardPrefsPatch,
): Promise<{ ok: true; prefs: BotCardPrefs } | { ok: false; reason: string }> {
  if (patch.pinStreamingCard !== undefined) {
    return serializePinStreamingCardConfigChange(
      larkAppId,
      () => updateBotCardPrefsInternal(larkAppId, patch),
    );
  }
  return updateBotCardPrefsInternal(larkAppId, patch);
}

async function updateBotCardPrefsInternal(
  larkAppId: string,
  patch: BotCardPrefsPatch,
): Promise<{ ok: true; prefs: BotCardPrefs } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const previousPinStreamingCard = bot.config.pinStreamingCard === true;

  const apply = (entry: any, key: keyof BotCardPrefs, val: boolean | undefined) => {
    if (val === undefined) return;
    if (val) entry[key] = true;
    else delete entry[key];
  };
  // Default-TRUE boolean: persist only an explicit `false`; `true` drops the key
  // (absent === on), keeping bots.json tidy and the default ON.
  const applyDefaultTrue = (entry: any, key: keyof BotCardPrefs, val: boolean | undefined) => {
    if (val === undefined) return;
    if (val) delete entry[key];
    else entry[key] = false;
  };
  // String prefs: store verbatim when non-blank, drop the key when blank/absent
  // so bots.json stays tidy (absent === "no prompt").
  const applyStr = (entry: any, key: keyof BotCardPrefs, val: string | undefined) => {
    if (val === undefined) return;
    if (val.trim()) entry[key] = val;
    else delete entry[key];
  };
  // Regular-group default mode: store only the non-default modes; 'chat-topic'
  // (the default) drops the key so bots.json stays tidy (absent === 'chat-topic').
  const applyMode = (entry: any, key: keyof BotCardPrefs, val: ChatReplyMode | undefined) => {
    if (val === undefined) return;
    if (val === 'chat' || val === 'new-topic' || val === 'shared') entry[key] = val;
    else delete entry[key];
  };
  // 4-tier @ policy: store only the non-default tiers; 'always' (default) drops
  // the key so bots.json stays tidy (absent === 'always').
  const applyMention = (entry: any, key: keyof BotCardPrefs, val: 'always' | 'topic' | 'never' | 'ambient' | undefined) => {
    if (val === undefined) return;
    if (val === 'topic' || val === 'never' || val === 'ambient') entry[key] = val;
    else delete entry[key];
  };
  // 文档订阅默认触发范围：只存 'all'；'mention-only'（默认）删键保持 bots.json 干净。
  const applyDocMode = (entry: any, key: keyof BotCardPrefs, val: 'mention-only' | 'all' | undefined) => {
    if (val === undefined) return;
    if (val === 'all') entry[key] = 'all';
    else delete entry[key];
  };
  // 用量显示位置：只存非默认模式；'streaming'（默认）删键保持 bots.json 干净
  // （absent === 'streaming'）。
  const applyUsageDisplay = (entry: any, key: keyof BotCardPrefs, val: UsageDisplayMode | undefined) => {
    if (val === undefined) return;
    if (val === 'footer' || val === 'off') entry[key] = val;
    else delete entry[key];
  };
  const applyTopicGroupMemory = (entry: any, val: TopicGroupMemoryConfig | undefined) => {
    if (val === undefined) return;
    const current = entry.topicGroupMemory && typeof entry.topicGroupMemory === 'object'
      ? { ...entry.topicGroupMemory }
      : {};
    if (typeof val.enabled === 'boolean') current.enabled = val.enabled;
    if (val.provider === 'auto' || val.provider === 'local' || val.provider === 'tencentdb') current.provider = val.provider;
    if (val.injectMode === 'off' || val.injectMode === 'summary' || val.injectMode === 'summary-and-facts') current.injectMode = val.injectMode;
    if (val.updateMode === 'off' || val.updateMode === 'manual' || val.updateMode === 'auto') current.updateMode = val.updateMode;
    if (typeof val.maxPromptChars === 'number' && Number.isInteger(val.maxPromptChars) && val.maxPromptChars > 0) {
      current.maxPromptChars = Math.min(val.maxPromptChars, 8_000);
    }
    if (typeof val.maxSummaryChars === 'number' && Number.isInteger(val.maxSummaryChars) && val.maxSummaryChars > 0) {
      current.maxSummaryChars = Math.min(val.maxSummaryChars, 10_000);
    }
    if (val.httpLlm && typeof val.httpLlm === 'object') {
      const http = current.httpLlm && typeof current.httpLlm === 'object' ? { ...current.httpLlm } : {};
      if (typeof val.httpLlm.enabled === 'boolean') http.enabled = val.httpLlm.enabled;
      if (typeof val.httpLlm.autoDiscoverCodex === 'boolean') http.autoDiscoverCodex = val.httpLlm.autoDiscoverCodex;
      if (typeof val.httpLlm.baseUrl === 'string') {
        if (val.httpLlm.baseUrl.trim()) http.baseUrl = val.httpLlm.baseUrl.trim();
        else delete http.baseUrl;
      }
      if (typeof val.httpLlm.model === 'string') {
        if (val.httpLlm.model.trim()) http.model = val.httpLlm.model.trim();
        else delete http.model;
      }
      if (val.httpLlm.api === 'auto' || val.httpLlm.api === 'responses' || val.httpLlm.api === 'chat-completions') http.api = val.httpLlm.api;
      if (typeof val.httpLlm.timeoutMs === 'number' && Number.isInteger(val.httpLlm.timeoutMs) && val.httpLlm.timeoutMs > 0) {
        http.timeoutMs = Math.min(val.httpLlm.timeoutMs, 300_000);
      }
      current.httpLlm = http;
    }
    if (val.tencentdb && typeof val.tencentdb === 'object') {
      const tencentdb = current.tencentdb && typeof current.tencentdb === 'object' ? { ...current.tencentdb } : {};
      for (const key of ['runtimeDir', 'endpoint', 'apiKey', 'serviceId', 'teamId', 'agentId', 'userId', 'panelUrl'] as const) {
        const value = val.tencentdb[key];
        if (typeof value !== 'string') continue;
        if (value.trim()) tencentdb[key] = value.trim();
        else delete tencentdb[key];
      }
      if (typeof val.tencentdb.maxResults === 'number' && Number.isInteger(val.tencentdb.maxResults) && val.tencentdb.maxResults > 0) {
        tencentdb.maxResults = Math.min(val.tencentdb.maxResults, 20);
      }
      if (typeof val.tencentdb.includePersona === 'boolean') tencentdb.includePersona = val.tencentdb.includePersona;
      if (typeof val.tencentdb.includeScenes === 'boolean') tencentdb.includeScenes = val.tencentdb.includeScenes;
      if (typeof val.tencentdb.timeoutMs === 'number' && Number.isInteger(val.tencentdb.timeoutMs) && val.tencentdb.timeoutMs > 0) {
        tencentdb.timeoutMs = Math.min(val.tencentdb.timeoutMs, 60_000);
      }
      current.tencentdb = tencentdb;
    }
    entry.topicGroupMemory = current;
  };

  const r = await rmwBotEntry<BotCardPrefs>(larkAppId, (entry) => {
    applyUsageDisplay(entry, 'usageDisplay', patch.usageDisplay);
    apply(entry, 'disableStreamingCard', patch.disableStreamingCard);
    apply(entry, 'pinStreamingCard', patch.pinStreamingCard);
    apply(entry, 'silentTurnReactions', patch.silentTurnReactions);
    apply(entry, 'codexAppCleanInput', patch.codexAppCleanInput);
    apply(entry, 'writableTerminalLinkInCard', patch.writableTerminalLinkInCard);
    apply(entry, 'privateCard', patch.privateCard);
    applyDefaultTrue(entry, 'thinkingCard', patch.thinkingCard);
    applyDefaultTrue(entry, 'senderTag', patch.senderTag);
    apply(entry, 'overloadAlert', patch.overloadAlert);
    applyDefaultTrue(entry, 'botToBotSameDir', patch.botToBotSameDir);
    apply(entry, 'autoStartOnGroupJoin', patch.autoStartOnGroupJoin);
    applyStr(entry, 'autoStartOnGroupJoinPrompt', patch.autoStartOnGroupJoinPrompt);
    applyStr(entry, 'autoStartOnGroupJoinSeed', patch.autoStartOnGroupJoinSeed);
    apply(entry, 'autoStartOnNewTopic', patch.autoStartOnNewTopic);
    applyMode(entry, 'regularGroupReplyMode', patch.regularGroupReplyMode);
    applyMention(entry, 'regularGroupMentionMode', patch.regularGroupMentionMode);
    applyDocMode(entry, 'docSubscribeDefaultMode', patch.docSubscribeDefaultMode);
    apply(entry, 'summaryMemory', patch.summaryMemory);
    applyStr(entry, 'summaryMemoryPath', patch.summaryMemoryPath);
    applyTopicGroupMemory(entry, patch.topicGroupMemory);
    const topicGroupMemory = resolveTopicGroupMemoryConfig(entry.topicGroupMemory);
    return {
      write: true,
      result: {
        usageDisplay: normalizeUsageDisplay(entry),
        disableStreamingCard: entry.disableStreamingCard === true,
        pinStreamingCard: entry.pinStreamingCard === true,
        silentTurnReactions: entry.silentTurnReactions === true,
        codexAppCleanInput: entry.codexAppCleanInput === true,
        writableTerminalLinkInCard: entry.writableTerminalLinkInCard === true,
        privateCard: entry.privateCard === true,
        thinkingCard: entry.thinkingCard !== false,
        senderTag: entry.senderTag !== false,
        overloadAlert: entry.overloadAlert === true,
        botToBotSameDir: entry.botToBotSameDir !== false,
        autoStartOnGroupJoin: entry.autoStartOnGroupJoin === true,
        autoStartOnGroupJoinPrompt: typeof entry.autoStartOnGroupJoinPrompt === 'string' ? entry.autoStartOnGroupJoinPrompt : '',
        autoStartOnGroupJoinSeed: typeof entry.autoStartOnGroupJoinSeed === 'string' ? entry.autoStartOnGroupJoinSeed : '',
        autoStartOnNewTopic: entry.autoStartOnNewTopic === true,
        regularGroupReplyMode: (entry.regularGroupReplyMode === 'chat' || entry.regularGroupReplyMode === 'new-topic' || entry.regularGroupReplyMode === 'shared')
          ? entry.regularGroupReplyMode
          : 'chat-topic',
        regularGroupMentionMode: (entry.regularGroupMentionMode === 'topic' || entry.regularGroupMentionMode === 'never' || entry.regularGroupMentionMode === 'ambient')
          ? entry.regularGroupMentionMode
          : 'always',
        docSubscribeDefaultMode: entry.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only',
        summaryMemory: entry.summaryMemory === true,
        summaryMemoryPath: typeof entry.summaryMemoryPath === 'string' && entry.summaryMemoryPath.trim() ? entry.summaryMemoryPath.trim() : 'summary.md',
        topicGroupMemory,
      },
    };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  // Sync in-memory config so live card builders / routing react without a restart.
  if (patch.usageDisplay !== undefined) {
    // Store only a non-default mode; 'streaming' (default) clears the key.
    bot.config.usageDisplay = (patch.usageDisplay && patch.usageDisplay !== DEFAULT_USAGE_DISPLAY)
      ? patch.usageDisplay
      : undefined;
  }
  if (patch.disableStreamingCard !== undefined) {
    bot.config.disableStreamingCard = patch.disableStreamingCard || undefined;
  }
  if (patch.pinStreamingCard !== undefined) {
    bot.config.pinStreamingCard = patch.pinStreamingCard || undefined;
  }
  if (patch.silentTurnReactions !== undefined) {
    bot.config.silentTurnReactions = patch.silentTurnReactions || undefined;
  }
  if (patch.codexAppCleanInput !== undefined) {
    bot.config.codexAppCleanInput = patch.codexAppCleanInput || undefined;
  }
  if (patch.writableTerminalLinkInCard !== undefined) {
    bot.config.writableTerminalLinkInCard = patch.writableTerminalLinkInCard || undefined;
  }
  if (patch.privateCard !== undefined) {
    bot.config.privateCard = patch.privateCard || undefined;
  }
  if (patch.thinkingCard !== undefined) {
    // Default true: store false explicitly, clear (→ default on) when true.
    bot.config.thinkingCard = patch.thinkingCard === false ? false : undefined;
  }
  if (patch.senderTag !== undefined) {
    // Default true: store false explicitly, clear (→ default on) when true.
    bot.config.senderTag = patch.senderTag === false ? false : undefined;
  }
  if (patch.overloadAlert !== undefined) {
    bot.config.overloadAlert = patch.overloadAlert || undefined;
  }
  if (patch.botToBotSameDir !== undefined) {
    // Default true: store false explicitly, clear (→ default on) when true.
    bot.config.botToBotSameDir = patch.botToBotSameDir === false ? false : undefined;
  }
  if (patch.autoStartOnGroupJoin !== undefined) {
    bot.config.autoStartOnGroupJoin = patch.autoStartOnGroupJoin || undefined;
  }
  if (patch.autoStartOnGroupJoinPrompt !== undefined) {
    bot.config.autoStartOnGroupJoinPrompt = patch.autoStartOnGroupJoinPrompt.trim() ? patch.autoStartOnGroupJoinPrompt : undefined;
  }
  if (patch.autoStartOnGroupJoinSeed !== undefined) {
    bot.config.autoStartOnGroupJoinSeed = patch.autoStartOnGroupJoinSeed.trim() ? patch.autoStartOnGroupJoinSeed : undefined;
  }
  if (patch.autoStartOnNewTopic !== undefined) {
    bot.config.autoStartOnNewTopic = patch.autoStartOnNewTopic || undefined;
  }
  if (patch.regularGroupReplyMode !== undefined) {
    bot.config.regularGroupReplyMode = (patch.regularGroupReplyMode === 'chat' || patch.regularGroupReplyMode === 'new-topic' || patch.regularGroupReplyMode === 'shared')
      ? patch.regularGroupReplyMode
      : undefined;
  }
  if (patch.regularGroupMentionMode !== undefined) {
    bot.config.regularGroupMentionMode = (patch.regularGroupMentionMode === 'topic' || patch.regularGroupMentionMode === 'never' || patch.regularGroupMentionMode === 'ambient')
      ? patch.regularGroupMentionMode
      : undefined;
  }
  if (patch.docSubscribeDefaultMode !== undefined) {
    bot.config.docSubscribeDefaultMode = patch.docSubscribeDefaultMode === 'all' ? 'all' : undefined;
  }
  if (patch.summaryMemory !== undefined) {
    bot.config.summaryMemory = patch.summaryMemory || undefined;
  }
  if (patch.summaryMemoryPath !== undefined) {
    bot.config.summaryMemoryPath = patch.summaryMemoryPath.trim() ? patch.summaryMemoryPath.trim() : undefined;
  }
  if (patch.topicGroupMemory !== undefined) {
    bot.config.topicGroupMemory = r.result.topicGroupMemory;
  }
  const nextPinStreamingCard = bot.config.pinStreamingCard === true;
  if (patch.pinStreamingCard !== undefined && previousPinStreamingCard !== nextPinStreamingCard) {
    notifyPinStreamingCardChanged(larkAppId, nextPinStreamingCard);
  }
  logger.info(
    `[card-prefs:${larkAppId}] usageDisplay=${r.result.usageDisplay} ` +
    `disableStreamingCard=${r.result.disableStreamingCard} ` +
    `pinStreamingCard=${r.result.pinStreamingCard} ` +
    `silentTurnReactions=${r.result.silentTurnReactions} ` +
    `codexAppCleanInput=${r.result.codexAppCleanInput} ` +
    `writableTerminalLinkInCard=${r.result.writableTerminalLinkInCard} privateCard=${r.result.privateCard} ` +
    `thinkingCard=${r.result.thinkingCard} ` +
    `senderTag=${r.result.senderTag} ` +
    `overloadAlert=${r.result.overloadAlert} ` +
    `autoStartOnGroupJoin=${r.result.autoStartOnGroupJoin} autoStartOnNewTopic=${r.result.autoStartOnNewTopic} ` +
    `regularGroupReplyMode=${r.result.regularGroupReplyMode} regularGroupMentionMode=${r.result.regularGroupMentionMode} ` +
    `botToBotSameDir=${r.result.botToBotSameDir} docSubscribeDefaultMode=${r.result.docSubscribeDefaultMode} ` +
    `summaryMemory=${r.result.summaryMemory} summaryMemoryPath=${r.result.summaryMemoryPath} ` +
    `topicGroupMemory=${r.result.topicGroupMemory.enabled}/${r.result.topicGroupMemory.provider}/${r.result.topicGroupMemory.injectMode}/${r.result.topicGroupMemory.updateMode} ` +
    `autoStartOnGroupJoinPrompt.len=${r.result.autoStartOnGroupJoinPrompt.length} ` +
    `autoStartOnGroupJoinSeed.len=${r.result.autoStartOnGroupJoinSeed.length}`,
  );
  return { ok: true, prefs: r.result };
}
