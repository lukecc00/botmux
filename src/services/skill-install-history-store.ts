import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DashboardSkillInstallRequest } from '../dashboard/skill-install-request.js';
import { skillInstallHistoryPath } from '../core/skills/registry-paths.js';
import { redactGitUrlCredentials } from '../core/skills/sources.js';
import type { SkillPackage, SkillSource } from '../core/skills/types.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

const MAX_SKILL_INSTALL_HISTORY = 20;

export interface SkillInstallHistoryEntry {
  id: string;
  source: string;
  path?: string;
  ref?: string;
  skillNames: string[];
  skillSourceKeys: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface SkillInstallHistoryFile {
  schemaVersion: 1;
  entries: SkillInstallHistoryEntry[];
}

function safeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()))];
}

function readHistoryFile(): SkillInstallHistoryFile {
  const file = skillInstallHistoryPath();
  if (!existsSync(file)) return { schemaVersion: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const entries: SkillInstallHistoryEntry[] = [];
    for (const raw of rawEntries) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const id = safeOptionalString(entry.id);
      const source = safeOptionalString(entry.source);
      const createdAt = safeOptionalString(entry.createdAt);
      const updatedAt = safeOptionalString(entry.updatedAt);
      if (!id || !source || !createdAt || !updatedAt) continue;
      const rawKeys = entry.skillSourceKeys && typeof entry.skillSourceKeys === 'object' && !Array.isArray(entry.skillSourceKeys)
        ? entry.skillSourceKeys as Record<string, unknown>
        : {};
      const skillSourceKeys = Object.fromEntries(Object.entries(rawKeys)
        .filter((pair): pair is [string, string] => !!pair[0] && typeof pair[1] === 'string' && pair[1].length > 0));
      entries.push({
        id,
        source: redactGitUrlCredentials(source),
        ...(safeOptionalString(entry.path) ? { path: safeOptionalString(entry.path) } : {}),
        ...(safeOptionalString(entry.ref) ? { ref: safeOptionalString(entry.ref) } : {}),
        skillNames: safeStringList(entry.skillNames),
        skillSourceKeys,
        createdAt,
        updatedAt,
      });
    }
    return { schemaVersion: 1, entries: entries.slice(0, MAX_SKILL_INSTALL_HISTORY) };
  } catch {
    return { schemaVersion: 1, entries: [] };
  }
}

function writeHistoryFile(history: SkillInstallHistoryFile): void {
  mkdirSync(dirname(skillInstallHistoryPath()), { recursive: true });
  atomicWriteFileSync(skillInstallHistoryPath(), `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
}

function agentbuddyHistorySource(request: Extract<DashboardSkillInstallRequest, { kind: 'agentbuddy' }>): string {
  const source = request.agentbuddy;
  const protocol = source.protocol ?? 'skill';
  if (source.collection) return `agentbuddy ${protocol} collection add ${source.collection}`;
  const version = source.version ? ` --version ${source.version}` : '';
  return `agentbuddy ${protocol} add ${source.group} --skill ${source.skill}${version}`;
}

export function installHistoryLocation(request: DashboardSkillInstallRequest): Pick<SkillInstallHistoryEntry, 'source' | 'path' | 'ref'> {
  if (request.kind === 'local') return { source: request.value };
  if (request.kind === 'git') {
    return {
      source: `git+${redactGitUrlCredentials(request.url)}`,
      ...(request.path ? { path: request.path } : {}),
      ...(request.ref ? { ref: request.ref } : {}),
    };
  }
  if (request.kind === 'github') {
    return {
      source: `https://github.com/${request.owner}/${request.repo}`,
      ...(request.path ? { path: request.path } : {}),
      ...(request.ref ? { ref: request.ref } : {}),
    };
  }
  return { source: agentbuddyHistorySource(request) };
}

function historyId(location: Pick<SkillInstallHistoryEntry, 'source' | 'path' | 'ref'>): string {
  return createHash('sha256')
    .update([location.source, location.path ?? '', location.ref ?? ''].join('\0'))
    .digest('hex')
    .slice(0, 20);
}

export function skillSourceHistoryKey(source: SkillSource): string {
  if (source.type === 'local-copy') return JSON.stringify({ type: source.type, originalPath: source.originalPath });
  if (source.type === 'local-link') return JSON.stringify({ type: source.type, path: source.path });
  if (source.type === 'git') return JSON.stringify({ type: source.type, url: redactGitUrlCredentials(source.url), path: source.path, ref: source.ref });
  if (source.type === 'github') return JSON.stringify({ type: source.type, owner: source.owner, repo: source.repo, path: source.path, ref: source.ref });
  if (source.type === 'agentbuddy') {
    return JSON.stringify({
      type: source.type,
      protocol: source.protocol,
      collection: source.collection,
      group: source.group,
      skill: source.skill,
      version: source.version,
    });
  }
  return JSON.stringify(source);
}

export function listSkillInstallHistory(): SkillInstallHistoryEntry[] {
  return readHistoryFile().entries;
}

export function findSkillInstallHistory(id: string): SkillInstallHistoryEntry | undefined {
  return readHistoryFile().entries.find(entry => entry.id === id);
}

export function recordSkillInstallHistory(request: DashboardSkillInstallRequest, skills: readonly SkillPackage[]): SkillInstallHistoryEntry | undefined {
  if (skills.length === 0) return undefined;
  const location = installHistoryLocation(request);
  const id = historyId(location);
  const now = new Date().toISOString();
  mkdirSync(dirname(skillInstallHistoryPath()), { recursive: true });
  return withFileLockSync(skillInstallHistoryPath(), () => {
    const history = readHistoryFile();
    const previous = history.entries.find(entry => entry.id === id);
    const skillSourceKeys = { ...(previous?.skillSourceKeys ?? {}) };
    for (const skill of skills) skillSourceKeys[skill.name] = skillSourceHistoryKey(skill.source);
    const entry: SkillInstallHistoryEntry = {
      id,
      ...location,
      skillNames: [...new Set([...(previous?.skillNames ?? []), ...skills.map(skill => skill.name)])].sort(),
      skillSourceKeys,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    history.entries = [entry, ...history.entries.filter(item => item.id !== id)].slice(0, MAX_SKILL_INSTALL_HISTORY);
    writeHistoryFile(history);
    return entry;
  });
}

export function installedSkillsForHistory(
  entry: SkillInstallHistoryEntry,
  installed: Readonly<Record<string, SkillPackage>>,
): string[] {
  return entry.skillNames.filter(name => {
    const skill = installed[name];
    return !!skill && entry.skillSourceKeys[name] === skillSourceHistoryKey(skill.source);
  });
}
