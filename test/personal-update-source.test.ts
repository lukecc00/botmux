import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('personal distribution source invariants', () => {
  it('pins the source installer to lukecc00/p/ai_open and ignores repo/ref overrides', () => {
    const installer = read('install.sh');
    expect(installer).toContain('REPO="lukecc00/botmux"');
    expect(installer).toContain('REF="p/ai_open"');
    expect(installer).toContain('SSH_URL="git@github.com:$REPO.git"');
    expect(installer).toContain('HTTPS_URL="https://github.com/$REPO.git"');
    expect(installer).toContain('GIT_TERMINAL_PROMPT=0');
    expect(installer).toContain('BatchMode=yes');
    expect(installer).not.toContain('${BOTMUX_INSTALL_REPO');
    expect(installer).not.toContain('${BOTMUX_INSTALL_REF');
    expect(installer).toContain('.botmux-install.json');
    expect(installer).toContain('--filter=blob:none');
    expect(installer).toContain('attempt $attempt/2');
    expect(installer).toContain('failed to download $REPO@$REF over SSH and HTTPS');
    expect(installer).toContain('./node_modules/.bin/tsc');
    expect(installer).toContain('node scripts/build-dashboard.mjs');
    expect(installer).not.toContain('$PNPM build');
    expect(installer).toContain('.cache/node/corepack/v1/pnpm/9.5.0/bin/pnpm.cjs');
    expect(installer).toContain('elif command -v pnpm');
    expect(installer).toContain('PNPM_CMD="npx --yes pnpm@9.5.0"');
    expect(installer).toContain('fs.renameSync(tmp, link)');
    expect(installer).not.toContain('mv -f "$APP_HOME/current.new"');
  });

  it('publishes GitHub releases only and never the official npm package', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toContain('Create GitHub Release');
    expect(workflow).toContain('dev-version.json');
    expect(workflow).toContain('must be an annotated tag');
    expect(workflow).toContain('refs/remotes/origin/p/ai_open');
    expect(workflow).toContain('TAG_COMMIT');
    expect(workflow).toContain('CHANNEL_COMMIT');
    expect(workflow).not.toContain('npm publish');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });

  it('keeps CLI and update checks on the personal repository', () => {
    expect(read('src/core/restart-report.ts')).toContain('GITHUB_REPO = PERSONAL_UPDATE_REPO');
    expect(read('src/utils/install-info.ts')).toContain("PERSONAL_UPDATE_REPO = 'lukecc00/botmux'");
    expect(read('src/utils/install-info.ts')).toContain("PERSONAL_UPDATE_REF = 'p/ai_open'");
    expect(read('src/core/update-check.ts')).toContain('raw.githubusercontent.com/${GITHUB_REPO}/${PERSONAL_UPDATE_REF}/dev-version.json');
    expect(read('src/core/github-source.ts')).toContain('git@github.com:${repo}.git');
    expect(read('src/core/botmux-update-monitor.ts')).toContain('startBotmuxUpdateMonitor');
    expect(read('src/core/botmux-update-monitor.ts')).toContain('managedSourceInstall()');
    expect(read('src/daemon.ts')).toContain('startBotmuxUpdateMonitor({');
  });
});
