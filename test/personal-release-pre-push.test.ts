import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-pre-push-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'p/ai_open'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  writeFileSync(join(root, 'dev-version.json'), '{"version":"3.2.10"}\n');
  writeFileSync(join(root, 'README.md'), 'test\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  execFileSync('git', ['tag', 'v3.14.0'], { cwd: root });
  const hook = join(root, 'pre-push');
  copyFileSync(resolve('scripts/git-hooks/pre-push'), hook);
  chmodSync(hook, 0o755);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('personal release pre-push guard', () => {
  it('allows the manifest-matching personal tag despite newer official tags', () => {
    const root = repo();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const result = spawnSync(join(root, 'pre-push'), [], {
      cwd: root,
      input: `refs/tags/v3.2.10 ${head} refs/tags/v3.2.10 ${'0'.repeat(40)}\n`,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });

  it('still rejects a non-manifest stable tag that would regress the shared tag set', () => {
    const root = repo();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const result = spawnSync(join(root, 'pre-push'), [], {
      cwd: root,
      input: `refs/tags/v3.2.8 ${head} refs/tags/v3.2.8 ${'0'.repeat(40)}\n`,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('拒绝推送');
  });
});
