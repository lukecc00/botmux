import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('personal distribution source invariants', () => {
  it('pins the source installer to lukecc00/p/ai_open and ignores repo/ref overrides', () => {
    const installer = read('install.sh');
    expect(installer).toContain('REPO="lukecc00/botmux"');
    expect(installer).toContain('REF="p/ai_open"');
    expect(installer).not.toContain('${BOTMUX_INSTALL_REPO');
    expect(installer).not.toContain('${BOTMUX_INSTALL_REF');
    expect(installer).toContain('.botmux-install.json');
    expect(installer).toContain('--filter=blob:none');
    expect(installer).toContain('attempt $attempt/3');
    expect(installer).toContain('failed to download $REPO@$REF after 3 attempts');
    expect(installer).toContain('./node_modules/.bin/tsc');
    expect(installer).toContain('node scripts/build-dashboard.mjs');
    expect(installer).not.toContain('$PNPM build');
  });

  it('publishes GitHub releases only and never the official npm package', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toContain('Create GitHub Release');
    expect(workflow).toContain('dev-version.json');
    expect(workflow).not.toContain('npm publish');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });

  it('keeps CLI and update checks on the personal repository', () => {
    expect(read('src/core/restart-report.ts')).toContain("GITHUB_REPO = 'lukecc00/botmux'");
    expect(read('src/core/update-check.ts')).toContain('raw.githubusercontent.com/lukecc00/botmux/p/ai_open/dev-version.json');
  });
});
