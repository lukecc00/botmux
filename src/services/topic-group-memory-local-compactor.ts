/**
 * Deterministic extractive compactor for topic-group memory.
 *
 * This is deliberately not presented as a local LLM. It approximates the
 * durable-memory behavior of model compaction with sentence extraction,
 * TextRank-style centrality, stability/noise scoring, semantic deduplication,
 * conservative supersession detection, and a full summary rebuild.
 */
import {
  cleanTopicGroupMemoryText,
  containsTopicGroupMemorySensitiveText,
  safeTopicGroupMemoryText,
  topicGroupMemoryTextKey,
} from './topic-group-memory-safety.js';
import {
  distillTopicGroupMemoryRules,
  extractTopicGroupMemoryResources,
} from './topic-group-memory-distiller.js';
import type {
  TopicGroupMemoryConfidence,
  TopicGroupMemoryDoc,
  TopicGroupMemoryResourceKind,
} from './topic-group-memory-store.js';

export type TopicGroupMemoryLocalKind = 'fact' | 'decision' | 'question';

export interface TopicGroupMemoryLocalPatch {
  contributionSummary: string;
  summaryReplacement: string;
  facts: string[];
  decisions: string[];
  openQuestions: string[];
  resources: Array<{ kind: TopicGroupMemoryResourceKind; title: string; url: string; description: string }>;
  obsoleteItems: string[];
  factConfidence: TopicGroupMemoryConfidence;
}

export interface TopicGroupMemoryLocalInput {
  oldMemory: TopicGroupMemoryDoc | null;
  userMessage?: string;
  finalOutput: string;
}

type CandidateSource = 'user' | 'final';

interface Candidate {
  text: string;
  source: CandidateSource;
  order: number;
  kind: TopicGroupMemoryLocalKind;
  explicit: boolean;
  features: Set<string>;
  score: number;
  rank: number;
}

interface MemoryText {
  text: string;
  kind: TopicGroupMemoryLocalKind;
}

const MAX_INPUT_CHARS = 24_000;
const MAX_CANDIDATES = 120;
const MAX_SELECTED_PER_KIND = 8;
const MAX_SUMMARY_CHARS = 1_600;

const DECISION_RE = /(?:已?(?:决定|确定|确认|约定)|采用|统一(?:使用|改为)?|默认(?:为|使用|开启|关闭)?|必须|应当|需要遵循|禁止|不得|不再|只(?:允许|保留|尝试|使用)|仅(?:允许|保留|使用)|优先(?:使用)?|策略(?:是|为)|规则(?:是|为)|方案(?:是|为)|链路(?:是|为)|改为|调整为|替换为|取消|废弃|后续(?:统一|必须|应当)|\b(?:decided|decision|must|should|shall|default|prefer|only|never|no longer|use instead)\b)/iu;
const FACT_RE = /(?:是|为|使用|支持|包含|位于|依赖|适用|生效|保持|共享|隔离|存储|读取|写入|映射|限制|不会|不参与|不共享|由.+负责|键(?:为|是|包含)|\b(?:is|are|uses?|supports?|contains?|depends?|stored?|mapped?|applies?|keyed|isolated)\b)/iu;
const QUESTION_RE = /(?:待确认|待决定|未确定|尚未确定|仍需确认|需要确认|有待|何时|是否|哪种|哪个|如何|怎么|\b(?:open question|unresolved|to be decided|whether|when|which)\b)/iu;
const STABILITY_RE = /(?:以后|后续|长期|始终|统一|默认|约定|规范|策略|原则|架构|边界|隔离|跨话题|共享记忆|配置|接口|协议|数据模型|存储键|memory|session|fallback|provider|localhost|http|cli|api|prd|ppe|repository|dashboard)/iu;
const SUPERSESSION_RE = /(?:改为|调整为|替换为|取代|不再|取消|废弃|弃用|instead|replace|supersed|no longer|deprecated?)/iu;
const NEGATION_RE = /(?:不再|不得|禁止|关闭|停用|取消|无需|不会|不使用|不共享|不允许|仅|只|never|\bnot\b|no longer|disable|disabled|off|without)/iu;
const PROGRESS_RE = /(?:^|[，,。.!；;\s])(?:收到|好的|明白|我先|接下来|现在我|随后我|稍后|正在|开始(?:处理|检查|修改|运行)|已开始|已完成|完成并部署|构建成功|测试通过|检查通过|运行了|执行了|已清理|已重启|部署完成|本轮|这次|刚才|预计|耗时|进度|阶段结论|结果是\s*\d+|\b(?:done|completed|working on|next I|tests? passed|build succeeded|deployed|running|status)\b)/iu;
const COMMAND_RE = /(?:^|\s)(?:[$#>]\s*)?(?:botmux|pnpm|npm|npx|yarn|git|curl|rg|grep|sed|cat|node|python\d*|docker|kubectl|make|cargo|go)\s+(?:--?[\w-]+|[\w./-]+)/iu;
const PATH_RE = /(?:^|\s)(?:~|\.{0,2}\/|\/[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]{3,}/u;
const TEST_COUNT_RE = /\b\d+\s*(?:\/\s*\d+|tests?|files?|passed|failed)\b|(?:测试|用例)\s*\d+\s*(?:个|项|通过|失败)/iu;
const VERSION_RE = /(?:revision|版本|version|commit|pid|session id|turn id)\s*[:=#]?\s*[A-Za-z0-9._-]+/iu;
const TRANSIENT_TIME_RE = /(?:今天|明天|昨天|刚刚|目前正在|稍后|几分钟后|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2})/iu;
const UNCERTAIN_RE = /(?:可能|也许|或许|建议|倾向|暂定|假设|猜测|无法确认|不能确认|尚不确定|未证实|\b(?:maybe|perhaps|might|could|suggest|tentative|unconfirmed|uncertain)\b)/iu;
const ACK_RE = /^(?:收到|好的|好|明白|了解|可以|ok|okay|thanks?|谢谢)[！!。,.，\s]*$/iu;
const HEADING_RE = /^(?:结论|最终结论|核心结论|说明|结果|总结|更新|状态|验证结果|完成情况)\s*[:：]?$/iu;
const EXPLICIT_LABEL_RE = /^(?:事实|fact|决策|决定|decision|待确认|问题|question|open question)\s*[:：]\s*/iu;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'is', 'are', 'be', 'with', 'in', 'on', 'this', 'that',
  'will', 'can', '已', '的', '了', '和', '与', '或', '在', '为', '是', '将', '把', '被', '由', '中', '后', '前',
  '一个', '当前', '本轮', '这个', '这些', '进行', '使用', '采用', '需要', '支持', '可以', '已经', '仍然',
]);

const CANONICAL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/当前\s*agent\s*cli|当前会话\s*agent\s*cli|current\s+agent\s+cli/giu, ' current_agent_cli '],
  [/会话|session/giu, ' current_session '],
  [/current_session\s*(?:的)?\s*agent\s*cli/giu, ' current_agent_cli '],
  [/agent\s*cli|代理\s*cli|客户端\s*cli/giu, ' agent_cli '],
  [/命令行|cli/giu, ' cli '],
  [/本地\s*http|http\s*llm|local\s*http/giu, ' local_http '],
  [/\bhttp\b/giu, ' local_http '],
  [/llm|模型/giu, ' llm '],
  [/失败以后|失败后|失败时|调用失败/giu, ' failure_after '],
  [/仅|只|只会|只尝试|只使用|only/giu, ' only '],
  [/使用|尝试|调用|走|use|try|attempt/giu, ' use '],
  [/轮询|依次尝试|逐个尝试|顺序尝试|fallback\s+chain/giu, ' poll_cli '],
  [/不再|禁止|不得|不会|never|no\s+longer/giu, ' no_longer '],
  [/跨\s*bot|不同\s*bot|other\s+bot/giu, ' cross_bot '],
  [/话题群|topic\s*group/giu, ' topic_group '],
  [/共享记忆|shared\s*memory/giu, ' shared_memory '],
  [/隔离|isolate(?:d)?/giu, ' isolated '],
  [/压缩总结|确定性(?:总结|压缩)|规则总结|本地压缩|compactor|compact/giu, ' local_compactor '],
];

function canonicalizeForSimilarity(value: string): string {
  let out = value;
  for (const [re, replacement] of CANONICAL_REPLACEMENTS) out = out.replace(re, replacement);
  return out;
}

function stripCodeAndMetadata(value: string): string {
  return value
    .replace(/```[\s\S]*?```/gu, '\n')
    .replace(/<(?:botmux_routing|botmux_builtin_skills|identity|session_id|sender|environment_context)[^>]*>[\s\S]*?<\/(?:botmux_routing|botmux_builtin_skills|identity|session_id|sender|environment_context)>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .slice(0, MAX_INPUT_CHARS);
}

function splitSentences(value: string): string[] {
  const out: string[] = [];
  const input = stripCodeAndMetadata(value);
  for (const rawLine of input.split(/\r?\n/u)) {
    let line = rawLine
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s*)/u, '')
      .replace(/^\s*>+\s*/u, '')
      .trim();
    if (!line || /^[-|:\s]+$/u.test(line) || HEADING_RE.test(line)) continue;
    if (/^\|.*\|$/u.test(line)) continue;
    const chunks = line.split(/(?<=[。！？!?；;])\s*/u);
    for (let chunk of chunks) {
      chunk = chunk.trim();
      if (chunk.length > 320) {
        const clauses = chunk.split(/(?<=[，,])\s*/u);
        for (const clause of clauses) if (clause.trim()) out.push(clause.trim());
      } else if (chunk) {
        out.push(chunk);
      }
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}

function withoutUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s<>()\[\]{}"'，。；、]+/giu, ' ');
}

function normalizeCandidate(value: string): string {
  return safeTopicGroupMemoryText(
    withoutUrls(value)
      .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)/u, '')
      .replace(EXPLICIT_LABEL_RE, '')
      .replace(/^(?:已确认|确认|结论|最终|注意)\s*[:：]\s*/u, '')
      .replace(/[。；;]+$/u, ''),
    800,
  );
}

function charNgrams(sequence: string, size: number): string[] {
  const compact = sequence.replace(/[\s\p{P}\p{S}]/gu, '');
  if (compact.length < size) return compact ? [compact] : [];
  const out: string[] = [];
  for (let i = 0; i <= compact.length - size; i += 1) out.push(compact.slice(i, i + size));
  return out;
}

function features(value: string, ignorePolarity = false): Set<string> {
  let normalized = canonicalizeForSimilarity(cleanTopicGroupMemoryText(value, 1_000)).toLocaleLowerCase();
  if (ignorePolarity) normalized = normalized.replace(NEGATION_RE, ' ');
  const out = new Set<string>();
  for (const word of normalized.match(/[a-z][a-z0-9_.-]{1,}|\d+(?:\.\d+)+/giu) ?? []) {
    const token = word.toLocaleLowerCase();
    if (!STOP_WORDS.has(token)) out.add(`w:${token}`);
  }
  for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (const token of charNgrams(sequence, 2)) if (!STOP_WORDS.has(token)) out.add(`c:${token}`);
    for (const token of charNgrams(sequence, 3)) if (!STOP_WORDS.has(token)) out.add(`t:${token}`);
  }
  return out;
}

function importantConcepts(value: string): Set<string> {
  const canonical = canonicalizeForSimilarity(value).toLocaleLowerCase();
  const concepts = new Set<string>();
  for (const token of canonical.match(/\b(?:local_http|llm|failure_after|only|use|poll_cli|no_longer|current_session|current_agent_cli|agent_cli|cli|cross_bot|topic_group|shared_memory|isolated|local_compactor|codex|traex|claude)\b/giu) ?? []) {
    concepts.add(token.toLocaleLowerCase());
  }
  if (/http/iu.test(value)) concepts.add('http');
  return concepts;
}

function conceptOverlap(left: string, right: string): number {
  const a = importantConcepts(left);
  const b = importantConcepts(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / Math.min(a.size, b.size);
}

function transitionSignature(value: string): string | undefined {
  const canonical = canonicalizeForSimilarity(value).toLocaleLowerCase();
  const marker = canonical.indexOf('failure_after');
  if (marker < 0) return undefined;
  const before = importantConcepts(canonical.slice(0, marker));
  const after = importantConcepts(canonical.slice(marker + 'failure_after'.length));
  const source = ['local_http', 'http', 'current_agent_cli', 'agent_cli', 'cli']
    .find(token => before.has(token));
  const target = ['local_compactor', 'current_agent_cli', 'poll_cli', 'agent_cli', 'codex', 'traex', 'claude', 'cli']
    .find(token => after.has(token));
  return source && target ? `${source}=>${target}` : undefined;
}

function cosineSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  for (const token of smaller) if (larger.has(token)) intersection += 1;
  return intersection / Math.sqrt(left.size * right.size);
}

export function topicGroupMemorySemanticSimilarity(left: string, right: string, ignorePolarity = false): number {
  const a = topicGroupMemoryTextKey(left);
  const b = topicGroupMemoryTextKey(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const containment = a.includes(b) || b.includes(a)
    ? Math.min(a.length, b.length) / Math.max(a.length, b.length)
    : 0;
  let similarity = Math.max(
    containment * 0.95,
    cosineSimilarity(features(a, ignorePolarity), features(b, ignorePolarity)),
    conceptOverlap(a, b) * 0.62,
  );
  const leftTransition = transitionSignature(a);
  const rightTransition = transitionSignature(b);
  if (leftTransition && rightTransition && leftTransition !== rightTransition) similarity = Math.min(similarity, 0.45);
  return similarity;
}

function classify(text: string, source: CandidateSource): TopicGroupMemoryLocalKind | null {
  if (UNCERTAIN_RE.test(text)) {
    return /(?:待确认|无法确认|不能确认|尚不确定|未证实|unconfirmed|uncertain)/iu.test(text)
      ? 'question'
      : null;
  }
  if (QUESTION_RE.test(text) || /[?？]$/u.test(text)) {
    // A direct user request is not an open project question unless it explicitly
    // says the issue remains unresolved.
    if (source === 'user' && !/(?:待确认|未确定|尚未|仍需|有待|open question|unresolved)/iu.test(text)) return null;
    return 'question';
  }
  if (DECISION_RE.test(text)) return 'decision';
  if (FACT_RE.test(text)) return 'fact';
  return null;
}

function hasDurableSignal(text: string): boolean {
  return DECISION_RE.test(text) || QUESTION_RE.test(text) || STABILITY_RE.test(text);
}

function isNoise(text: string, source: CandidateSource): boolean {
  if (text.length < 8 || text.length > 800 || ACK_RE.test(text)) return true;
  if (containsTopicGroupMemorySensitiveText(text)) return true;
  if (COMMAND_RE.test(text) || TEST_COUNT_RE.test(text) || VERSION_RE.test(text)) return true;
  if (PATH_RE.test(text) && !hasDurableSignal(text)) return true;
  if (TRANSIENT_TIME_RE.test(text) && !hasDurableSignal(text)) return true;
  if (PROGRESS_RE.test(text) && !hasDurableSignal(text)) return true;
  if (source === 'final' && /^(?:fix|implement|update|check|run|help)\b/iu.test(text) && !hasDurableSignal(text)) return true;
  return false;
}

function explicitKind(raw: string): TopicGroupMemoryLocalKind | null {
  if (/^(?:决策|决定|decision)\s*[:：]/iu.test(raw)) return 'decision';
  if (/^(?:待确认|问题|question|open question)\s*[:：]/iu.test(raw)) return 'question';
  if (/^(?:事实|fact)\s*[:：]/iu.test(raw)) return 'fact';
  return null;
}

function centrality(candidates: Candidate[]): void {
  if (candidates.length <= 1) {
    if (candidates[0]) candidates[0].rank = 1;
    return;
  }
  const edges = candidates.map(() => new Map<number, number>());
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const similarity = cosineSimilarity(candidates[i].features, candidates[j].features);
      if (similarity < 0.08) continue;
      edges[i].set(j, similarity);
      edges[j].set(i, similarity);
    }
  }
  let ranks = candidates.map(() => 1 / candidates.length);
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const next = candidates.map(() => 0.15 / candidates.length);
    for (let i = 0; i < candidates.length; i += 1) {
      const total = [...edges[i].values()].reduce((sum, value) => sum + value, 0);
      if (!total) {
        for (let j = 0; j < candidates.length; j += 1) next[j] += 0.85 * ranks[i] / candidates.length;
        continue;
      }
      for (const [j, weight] of edges[i]) next[j] += 0.85 * ranks[i] * weight / total;
    }
    ranks = next;
  }
  const max = Math.max(...ranks, 1 / candidates.length);
  candidates.forEach((candidate, index) => { candidate.rank = ranks[index] / max; });
}

function sourceAgreement(candidate: Candidate, candidates: Candidate[]): number {
  let best = 0;
  for (const other of candidates) {
    if (candidate === other || candidate.source === other.source) continue;
    best = Math.max(best, cosineSimilarity(candidate.features, other.features));
  }
  return best;
}

function scoreCandidates(candidates: Candidate[]): void {
  centrality(candidates);
  for (const candidate of candidates) {
    let score = candidate.source === 'final' ? 1.8 : 0.7;
    score += candidate.kind === 'decision' ? 3.4 : candidate.kind === 'question' ? 2.8 : 2.4;
    if (candidate.explicit) score += 4.5;
    if (STABILITY_RE.test(candidate.text)) score += 1.3;
    if (candidate.text.length >= 16 && candidate.text.length <= 260) score += 0.8;
    if (/[A-Za-z][A-Za-z0-9_./-]{2,}|[a-z][A-Z]|\b[A-Z]{2,}\b/u.test(candidate.text)) score += 0.4;
    score += Math.min(1.8, sourceAgreement(candidate, candidates) * 2.4);
    score += candidate.rank * 1.2;
    if (PROGRESS_RE.test(candidate.text)) score -= 2.5;
    if (TRANSIENT_TIME_RE.test(candidate.text)) score -= 1.2;
    candidate.score = score;
  }
}

function buildCandidates(input: TopicGroupMemoryLocalInput): Candidate[] {
  const candidates: Candidate[] = [];
  let order = 0;
  const add = (raw: string, source: CandidateSource): void => {
    const explicit = explicitKind(raw);
    const text = normalizeCandidate(raw);
    if (!text || isNoise(text, source)) return;
    const kind = explicit ?? classify(text, source);
    if (!kind) return;
    candidates.push({ text, source, order: order++, kind, explicit: !!explicit, features: features(text), score: 0, rank: 0 });
  };
  for (const sentence of splitSentences(input.userMessage ?? '')) add(sentence, 'user');
  for (const sentence of splitSentences(input.finalOutput)) add(sentence, 'final');
  scoreCandidates(candidates);
  return candidates;
}

function selectCandidates(candidates: Candidate[]): Candidate[] {
  const thresholds: Record<TopicGroupMemoryLocalKind, number> = { decision: 5.0, fact: 4.8, question: 5.1 };
  const sorted = [...candidates]
    .filter(candidate => candidate.explicit || candidate.score >= thresholds[candidate.kind])
    .sort((a, b) => b.score - a.score || (a.source === b.source ? a.order - b.order : a.source === 'final' ? -1 : 1));
  const selected: Candidate[] = [];
  const counts: Record<TopicGroupMemoryLocalKind, number> = { decision: 0, fact: 0, question: 0 };
  for (const candidate of sorted) {
    if (counts[candidate.kind] >= MAX_SELECTED_PER_KIND) continue;
    const duplicate = selected.find(existing =>
      existing.kind === candidate.kind && topicGroupMemorySemanticSimilarity(existing.text, candidate.text) >= 0.60);
    if (duplicate) continue;
    selected.push(candidate);
    counts[candidate.kind] += 1;
  }
  return selected.sort((a, b) => a.order - b.order);
}

function oldMemoryTexts(memory: TopicGroupMemoryDoc | null): MemoryText[] {
  if (!memory) return [];
  return [
    ...memory.facts.map(item => ({ text: item.text, kind: 'fact' as const })),
    ...memory.decisions.map(item => ({ text: item.text, kind: 'decision' as const })),
    ...memory.openQuestions.map(item => ({ text: item.text, kind: 'question' as const })),
  ];
}

function findObsolete(memory: TopicGroupMemoryDoc | null, selected: Candidate[]): string[] {
  const obsolete = new Set<string>();
  for (const old of oldMemoryTexts(memory)) {
    for (const candidate of selected) {
      const similarity = topicGroupMemorySemanticSimilarity(old.text, candidate.text);
      const topicSimilarity = Math.max(
        topicGroupMemorySemanticSimilarity(old.text, candidate.text, true),
        conceptOverlap(old.text, candidate.text) * 0.62,
      );
      const polarityChanged = NEGATION_RE.test(old.text) !== NEGATION_RE.test(candidate.text);
      const questionResolved = old.kind === 'question' && candidate.kind !== 'question' && topicSimilarity >= 0.34;
      const superseded = SUPERSESSION_RE.test(candidate.text) && topicSimilarity >= 0.28;
      const nearDuplicate = old.kind === candidate.kind && similarity >= 0.74;
      const contradiction = polarityChanged && topicSimilarity >= 0.48;
      if (questionResolved || superseded || nearDuplicate || contradiction) obsolete.add(old.text);
    }
  }
  return [...obsolete];
}

function semanticUnique(values: string[], maxItems: number): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const text = safeTopicGroupMemoryText(raw, 800);
    if (!text) continue;
    const duplicate = out.some(existing => topicGroupMemorySemanticSimilarity(existing, text) >= 0.60);
    if (duplicate) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function oldSummarySentences(memory: TopicGroupMemoryDoc | null): string[] {
  if (!memory?.summary.trim()) return [];
  return splitSentences(memory.summary)
    .map(normalizeCandidate)
    .filter(text => text.length >= 12 && !containsTopicGroupMemorySensitiveText(text));
}

function rebuildSummary(
  memory: TopicGroupMemoryDoc | null,
  selected: Candidate[],
  obsoleteItems: string[],
): string {
  const obsoleteKeys = new Set(obsoleteItems.map(topicGroupMemoryTextKey));
  const old = oldMemoryTexts(memory).filter(item => !obsoleteKeys.has(topicGroupMemoryTextKey(item.text)));
  const decisions = semanticUnique([
    ...selected.filter(item => item.kind === 'decision').map(item => item.text),
    ...old.filter(item => item.kind === 'decision').map(item => item.text),
  ], 5);
  const retainedSummary = oldSummarySentences(memory).filter(text => {
    if (obsoleteItems.some(item => topicGroupMemorySemanticSimilarity(item, text) >= 0.48)) return false;
    return !selected.some(candidate =>
      SUPERSESSION_RE.test(candidate.text)
      && Math.max(topicGroupMemorySemanticSimilarity(text, candidate.text, true), conceptOverlap(text, candidate.text) * 0.62) >= 0.28);
  });
  const facts = semanticUnique([
    ...selected.filter(item => item.kind === 'fact').map(item => item.text),
    ...old.filter(item => item.kind === 'fact').map(item => item.text),
    ...retainedSummary,
  ].filter(text => !decisions.some(decision => topicGroupMemorySemanticSimilarity(decision, text) >= 0.72)), 6);
  const questions = semanticUnique([
    ...selected.filter(item => item.kind === 'question').map(item => item.text),
    ...old.filter(item => item.kind === 'question').map(item => item.text),
  ], 3);
  const sections: string[] = [];
  if (decisions.length) sections.push(`决策与约束：${decisions.join('；')}。`);
  if (facts.length) sections.push(`稳定背景：${facts.join('；')}。`);
  if (questions.length) sections.push(`待确认：${questions.join('；')}。`);
  return safeTopicGroupMemoryText(sections.join('\n'), MAX_SUMMARY_CHARS);
}

function mergeStrictMarkerCandidates(input: TopicGroupMemoryLocalInput, selected: Candidate[]): Candidate[] {
  const strict = distillTopicGroupMemoryRules([input.userMessage ?? '', input.finalOutput].filter(Boolean).join('\n'));
  if (!strict) return selected;
  const out = [...selected];
  let order = selected.reduce((max, item) => Math.max(max, item.order), -1) + 1;
  const add = (text: string, kind: TopicGroupMemoryLocalKind): void => {
    const cleaned = safeTopicGroupMemoryText(text, 800);
    if (!cleaned || out.some(item => item.kind === kind && topicGroupMemorySemanticSimilarity(item.text, cleaned) >= 0.60)) return;
    out.push({ text: cleaned, source: 'final', order: order++, kind, explicit: true, features: features(cleaned), score: 99, rank: 1 });
  };
  strict.facts.forEach(text => add(text, 'fact'));
  strict.decisions.forEach(text => add(text, 'decision'));
  strict.openQuestions.forEach(text => add(text, 'question'));
  return out;
}

function contribution(selected: Candidate[], resources: TopicGroupMemoryLocalPatch['resources']): string {
  const candidate = selected.find(item => item.kind === 'decision')
    ?? selected.find(item => item.kind === 'fact')
    ?? selected.find(item => item.kind === 'question');
  if (candidate) return safeTopicGroupMemoryText(candidate.text, 500);
  const resource = resources[0];
  return resource ? safeTopicGroupMemoryText(`${resource.title}: ${resource.url}`, 500) : '';
}

export function distillTopicGroupMemoryLocal(input: TopicGroupMemoryLocalInput): TopicGroupMemoryLocalPatch | null {
  if (!input.finalOutput.trim() || input.finalOutput.trim().length < 8) return null;
  let selected = selectCandidates(buildCandidates(input));
  selected = mergeStrictMarkerCandidates(input, selected);
  const resources = extractTopicGroupMemoryResources([input.userMessage ?? '', input.finalOutput].filter(Boolean).join('\n'));
  const obsoleteItems = findObsolete(input.oldMemory, selected);
  if (!selected.length && !resources.length && !obsoleteItems.length) return null;
  const contributionSummary = contribution(selected, resources);
  if (!contributionSummary) return null;
  const summaryReplacement = rebuildSummary(input.oldMemory, selected, obsoleteItems);
  const facts = semanticUnique(selected.filter(item => item.kind === 'fact').map(item => item.text), MAX_SELECTED_PER_KIND);
  const decisions = semanticUnique(selected.filter(item => item.kind === 'decision').map(item => item.text), MAX_SELECTED_PER_KIND);
  const openQuestions = semanticUnique(selected.filter(item => item.kind === 'question').map(item => item.text), MAX_SELECTED_PER_KIND);
  return {
    contributionSummary,
    summaryReplacement,
    facts,
    decisions,
    openQuestions,
    resources,
    obsoleteItems,
    factConfidence: selected.some(item => item.explicit) ? 'confirmed' : 'inferred',
  };
}

function keepLatestSemanticUnique<T extends { text: string }>(entries: T[]): T[] {
  const kept: T[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry.text.trim()) continue;
    if (kept.some(newer => topicGroupMemorySemanticSimilarity(newer.text, entry.text) >= 0.60)) continue;
    kept.unshift(entry);
  }
  return kept;
}

/** Semantic maintenance compaction for an existing memory document. The newest
 * paraphrase/policy statement wins, while resource/source metadata remains on
 * the retained entry. A concise extractive summary is rebuilt from the compact
 * structured state and any still-useful summary-only sentences. */
export function compactTopicGroupMemoryLocalDoc(doc: TopicGroupMemoryDoc): TopicGroupMemoryDoc {
  const compacted: TopicGroupMemoryDoc = {
    ...doc,
    facts: keepLatestSemanticUnique(doc.facts),
    decisions: keepLatestSemanticUnique(doc.decisions),
    openQuestions: keepLatestSemanticUnique(doc.openQuestions),
  };
  compacted.summary = rebuildSummary(compacted, [], []);
  return compacted;
}
