import { describe, expect, it } from 'vitest';
import {
  readSkillInstallDraft,
  SKILL_INSTALL_DRAFT_STORAGE_KEY,
  writeSkillInstallDraft,
} from '../src/dashboard/web/skill-install-draft.js';

function memoryStorage(initial?: string): Storage {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(SKILL_INSTALL_DRAFT_STORAGE_KEY, initial);
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('Skill install draft storage', () => {
  it('persists and restores source, path, and ref', () => {
    const storage = memoryStorage();
    expect(writeSkillInstallDraft(storage, {
      source: 'https://github.com/acme/skills',
      path: 'skills/review',
      ref: 'main',
    })).toBe(true);

    expect(readSkillInstallDraft(storage)).toEqual({
      source: 'https://github.com/acme/skills',
      path: 'skills/review',
      ref: 'main',
    });
  });

  it('ignores malformed or structurally invalid values', () => {
    expect(readSkillInstallDraft(memoryStorage('{bad json'))).toEqual({ source: '', path: '', ref: '' });
    expect(readSkillInstallDraft(memoryStorage(JSON.stringify({ source: 1, path: '', ref: '' })))).toEqual({ source: '', path: '', ref: '' });
  });

  it('does not persist an HTTP URL containing credentials', () => {
    const storage = memoryStorage(JSON.stringify({ source: 'old', path: '', ref: '' }));
    expect(writeSkillInstallDraft(storage, {
      source: 'https://token@example.com/acme/private-skills.git',
      path: '',
      ref: '',
    })).toBe(false);
    expect(storage.getItem(SKILL_INSTALL_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('fails closed when browser storage is unavailable', () => {
    const storage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(readSkillInstallDraft(storage)).toEqual({ source: '', path: '', ref: '' });
    expect(writeSkillInstallDraft(storage, { source: '/tmp/skills', path: '', ref: '' })).toBe(false);
  });
});
