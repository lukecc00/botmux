/** Strict marker/resource fallback used by the richer local compactor. */
import {
  containsTopicGroupMemorySensitiveText,
  safeTopicGroupMemoryUrl,
  safeTopicGroupMemoryText,
} from './topic-group-memory-safety.js';
import type { TopicGroupMemoryResourceKind } from './topic-group-memory-store.js';

export interface TopicGroupMemoryRulePatch {
  contributionSummary: string;
  facts: string[];
  decisions: string[];
  openQuestions: string[];
  resources: Array<{ kind: TopicGroupMemoryResourceKind; title: string; url: string; description: string }>;
}

const URL_RE = /https?:\/\/[^\s<>()\[\]{}"'，。；、]+/giu;

function resourceKindForContext(context: string): TopicGroupMemoryResourceKind {
  if (/\bprd\b|产品需求|需求文档/iu.test(context)) return 'prd';
  if (/实验|experiment|ab\s*test|a\/b/iu.test(context)) return 'experiment';
  if (/\bppe\b|预发|预发布|preview|staging/iu.test(context)) return 'ppe';
  if (/配置|config|接入方法|使用方法/iu.test(context)) return 'config';
  if (/设计稿|figma|sketch|design/iu.test(context)) return 'design';
  if (/\bapi\b|接口文档|openapi|swagger/iu.test(context)) return 'api';
  if (/代码|仓库|repo|repository|gitlab|github/iu.test(context)) return 'repository';
  if (/看板|dashboard|监控/iu.test(context)) return 'dashboard';
  if (/文档|doc|wiki/iu.test(context)) return 'document';
  return 'other';
}

export function extractTopicGroupMemoryResources(content: string): TopicGroupMemoryRulePatch['resources'] {
  const resources: TopicGroupMemoryRulePatch['resources'] = [];
  const urls = new Set<string>();
  for (const match of content.matchAll(URL_RE)) {
    const url = safeTopicGroupMemoryUrl(match[0]);
    if (!url || urls.has(url)) continue;
    urls.add(url);
    const matchIndex = match.index ?? 0;
    const lineStart = Math.max(0, content.lastIndexOf('\n', matchIndex - 1) + 1);
    const nextNewline = content.indexOf('\n', matchIndex + match[0].length);
    const lineEnd = nextNewline < 0 ? content.length : nextNewline;
    const lineContext = safeText(content.slice(lineStart, lineEnd), 300);
    const start = Math.max(0, matchIndex - 120);
    const end = Math.min(content.length, matchIndex + match[0].length + 120);
    const context = safeText(content.slice(start, end), 300);
    const lineKind = resourceKindForContext(lineContext);
    const kind = lineKind === 'other' ? resourceKindForContext(context) : lineKind;
    const before = safeText(content.slice(lineStart, matchIndex), 120)
      .replace(/(?:链接|地址|url)\s*[:：]?\s*$/iu, '')
      .trim();
    const title = before.split(/[。；;\n]/u).pop()?.trim().slice(-100) || `${kind} resource`;
    resources.push({ kind, title, url, description: context });
    if (resources.length >= 10) break;
  }
  return resources;
}

function safeText(value: string, max = 800): string {
  return safeTopicGroupMemoryText(value, max);
}

function firstMeaningfulLine(content: string): string {
  for (const raw of content.split(/\r?\n/u)) {
    const line = safeText(raw, 500);
    if (line.length >= 12) return line;
  }
  return safeText(content, 500);
}

function markerBody(content: string): string {
  const xml = content.match(/<shared_memory_update>([\s\S]*?)<\/shared_memory_update>/iu)?.[1];
  if (xml) return xml;
  const marker = content.match(/【共享记忆】\s*([\s\S]*)/u)?.[1];
  return marker ?? '';
}

export function distillTopicGroupMemoryRules(finalOutput: string): TopicGroupMemoryRulePatch | null {
  const trimmed = finalOutput.trim();
  if (trimmed.length < 20) return null;

  const facts: string[] = [];
  const decisions: string[] = [];
  const openQuestions: string[] = [];
  const resources = extractTopicGroupMemoryResources(trimmed);
  const body = markerBody(trimmed);
  if (body && !containsTopicGroupMemorySensitiveText(body)) {
    for (const raw of body.split(/\r?\n/u)) {
      const line = safeText(raw.replace(/^[-*]\s*/u, ''), 800);
      if (!line) continue;
      if (/^(?:事实|fact)\s*[:：]/iu.test(line)) facts.push(line.replace(/^(?:事实|fact)\s*[:：]\s*/iu, ''));
      else if (/^(?:决策|决定|decision)\s*[:：]/iu.test(line)) decisions.push(line.replace(/^(?:决策|决定|decision)\s*[:：]\s*/iu, ''));
      else if (/^(?:待确认|问题|question|open question)\s*[:：]/iu.test(line)) openQuestions.push(line.replace(/^(?:待确认|问题|question|open question)\s*[:：]\s*/iu, ''));
      else facts.push(line);
    }
  }
  if (!body && resources.length === 0) return null;
  if (body && facts.length === 0 && decisions.length === 0 && openQuestions.length === 0 && resources.length === 0) return null;
  const contributionSummary = firstMeaningfulLine(trimmed);
  if (!contributionSummary) return null;
  return {
    contributionSummary,
    facts: [...new Set(facts)].slice(0, 10),
    decisions: [...new Set(decisions)].slice(0, 10),
    openQuestions: [...new Set(openQuestions)].slice(0, 10),
    resources,
  };
}
