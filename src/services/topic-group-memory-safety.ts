/** Shared safety boundary for local-compactor and LLM topic-group memory updates. */
export const TOPIC_GROUP_MEMORY_SENSITIVE_RE = /(?:authorization\s*:|bearer\s+[a-z0-9._~+\/-]{12,}|cookie\s*:|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk|pk)-[a-z0-9_-]{12,}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?<!\d)1[3-9]\d{9}(?!\d)|\b\d{17}[\dX]\b|\b(?:ou|on|oc|om)_[a-z0-9]{16,}\b)/iu;

export function containsTopicGroupMemorySensitiveText(value: string): boolean {
  return TOPIC_GROUP_MEMORY_SENSITIVE_RE.test(value);
}

export function cleanTopicGroupMemoryText(value: string, maxChars = 1_000): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

export function safeTopicGroupMemoryText(value: string, maxChars = 1_000): string {
  const cleaned = cleanTopicGroupMemoryText(value, maxChars);
  return containsTopicGroupMemorySensitiveText(cleaned) ? '' : cleaned;
}

export function topicGroupMemoryTextKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

const SENSITIVE_URL_QUERY_KEY_RE = /(?:^|[_-])(?:access[_-]?token|auth|authorization|code|credential|jwt|key|password|passwd|secret|signature|sig|token)(?:$|[_-])/iu;

/** Normalize a reusable engineering-resource URL without ever preserving
 * fragments or value-shaped credential parameters. Ordinary experiment/PPE
 * query parameters remain intact because they often select the actual page or
 * environment being documented. */
export function safeTopicGroupMemoryUrl(value: string, maxChars = 2_048): string {
  const raw = value.trim();
  if (!raw || raw.length > maxChars || containsTopicGroupMemorySensitiveText(raw)) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return '';
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_URL_QUERY_KEY_RE.test(key)) return '';
  }
  url.hash = '';
  const normalized = url.toString();
  return normalized.length <= maxChars ? normalized : '';
}
