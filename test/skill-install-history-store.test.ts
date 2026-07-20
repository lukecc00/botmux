import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSkillInstallRequest } from '../src/dashboard/skill-install-request.js';
import type { SkillPackage } from '../src/core/skills/types.js';
import {
  installedSkillsForHistory,
  listSkillInstallHistory,
  recordSkillInstallHistory,
} from '../src/services/skill-install-history-store.js';

function skill(name: string, source: SkillPackage['source']): SkillPackage {
  return {
    id: name,
    name,
    tags: [],
    rootDir: `/store/${name}`,
    entrypoint: `/store/${name}/SKILL.md`,
    source,
  };
}

describe('skill install history store', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-skill-history-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('persists and merges successful installs from the same location', () => {
    const request: DashboardSkillInstallRequest = {
      kind: 'github',
      owner: 'acme',
      repo: 'skills',
      ref: 'main',
      skillNames: [],
      all: false,
      fullDepth: false,
    };
    recordSkillInstallHistory(request, [skill('deploy', {
      type: 'github', owner: 'acme', repo: 'skills', path: 'skills/deploy', ref: 'main',
    })]);
    recordSkillInstallHistory(request, [skill('review', {
      type: 'github', owner: 'acme', repo: 'skills', path: 'skills/review', ref: 'main',
    })]);

    expect(listSkillInstallHistory()).toEqual([
      expect.objectContaining({
        source: 'https://github.com/acme/skills',
        ref: 'main',
        skillNames: ['deploy', 'review'],
      }),
    ]);
  });

  it('updates only Skills that are still installed from the recorded location', () => {
    const request: DashboardSkillInstallRequest = {
      kind: 'local',
      value: '/source/skills',
      link: false,
      skillNames: [],
      all: false,
      fullDepth: false,
    };
    const deploy = skill('deploy', { type: 'local-copy', originalPath: '/source/skills/deploy' });
    const review = skill('review', { type: 'local-copy', originalPath: '/source/skills/review' });
    const entry = recordSkillInstallHistory(request, [deploy, review])!;

    expect(installedSkillsForHistory(entry, {
      deploy,
      review: skill('review', { type: 'local-copy', originalPath: '/another/source/review' }),
    })).toEqual(['deploy']);
  });
});
