export const SKILL_INSTALL_DRAFT_STORAGE_KEY = 'botmux.dashboard.skills.install-draft.v1';

const MAX_INSTALL_DRAFT_FIELD_LENGTH = 8_192;

export interface SkillInstallDraft {
  source: string;
  path: string;
  ref: string;
}

type SkillInstallDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safeDraftField(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_INSTALL_DRAFT_FIELD_LENGTH ? value : null;
}

function includesUrlCredentials(source: string): boolean {
  const candidate = source.trim().replace(/^git\+/, '');
  if (!/^https?:\/\//i.test(candidate)) return false;
  try {
    const url = new URL(candidate);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    // A malformed URL is handled by the install parser later. Do not mistake it
    // for a safe credential-free URL merely because URL parsing failed here.
    return /^(?:https?):\/\/[^/?#]*@/i.test(candidate);
  }
}

export function readSkillInstallDraft(storage?: Pick<Storage, 'getItem'> | null): SkillInstallDraft {
  const empty: SkillInstallDraft = { source: '', path: '', ref: '' };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(SKILL_INSTALL_DRAFT_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const source = safeDraftField(parsed.source);
    const path = safeDraftField(parsed.path);
    const ref = safeDraftField(parsed.ref);
    if (source === null || path === null || ref === null || includesUrlCredentials(source)) return empty;
    return { source, path, ref };
  } catch {
    return empty;
  }
}

export function writeSkillInstallDraft(
  storage: SkillInstallDraftStorage | null | undefined,
  draft: SkillInstallDraft,
): boolean {
  if (!storage) return false;
  const source = safeDraftField(draft.source);
  const path = safeDraftField(draft.path);
  const ref = safeDraftField(draft.ref);
  if (source === null || path === null || ref === null) return false;
  try {
    if (includesUrlCredentials(source)) {
      storage.removeItem(SKILL_INSTALL_DRAFT_STORAGE_KEY);
      return false;
    }
    storage.setItem(SKILL_INSTALL_DRAFT_STORAGE_KEY, JSON.stringify({ source, path, ref }));
    return true;
  } catch {
    return false;
  }
}
