/**
 * GitHub source access over SSH.
 *
 * The Dashboard normally uses GitHub's HTTPS API because it is cheap and
 * returns structured release data.  Some managed hosts, however, cannot reach
 * github.com/raw.githubusercontent.com and share an exhausted unauthenticated
 * API quota, while their configured git@github.com SSH remote still works.
 * These helpers provide a bounded, non-interactive fallback for that case.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GithubTagAnnotation {
  body: string;
  createdAt: string | null;
}

export interface GithubGitFallback {
  /** Read one repository file from an exact branch/ref without enumerating tags. */
  readFileAtRef?: (
    repo: string,
    ref: string,
    path: string,
    timeoutMs?: number,
  ) => Promise<string | null>;
  listTags: (repo: string, timeoutMs?: number) => Promise<string[] | null>;
  readTagAnnotations: (
    repo: string,
    tags: string[],
    timeoutMs?: number,
  ) => Promise<Map<string, GithubTagAnnotation> | null>;
}

function githubSshUrl(repo: string): string {
  return `git@github.com:${repo}.git`;
}

function runGit(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        // Never let a Dashboard request hang on an SSH password/host prompt.
        // Honour an operator-provided command (for a proxy or alternate key).
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND
          || 'ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new',
      },
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}


/**
 * Read one file from an exact remote ref over SSH. This is the safe fallback
 * for release-channel manifests: a fork can contain upstream tags, so scanning
 * all tags cannot establish which versions belong to the fork's own channel.
 */
export async function readGithubFileAtRefViaSsh(
  repo: string,
  ref: string,
  path: string,
  timeoutMs = 12_000,
): Promise<string | null> {
  // These are passed to git as argv (never a shell), but reject option-like or
  // traversal-shaped values anyway so this helper remains a narrow boundary.
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..')) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith('/') || path.includes('..')) return null;

  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'botmux-github-ref-'));
    await runGit([
      'clone', '--bare', '--quiet', '--filter=blob:none', '--depth=1',
      '--single-branch', '--branch', ref,
      githubSshUrl(repo),
      dir,
    ], timeoutMs);
    // The partial clone keeps the first transfer small. `show` lazily fetches
    // only the requested blob through the configured promisor remote.
    return await runGit(['--git-dir', dir, 'show', `HEAD:${path}`], timeoutMs);
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** List v-prefixed tags without downloading the repository. null on failure. */
export async function listGithubTagsViaSsh(repo: string, timeoutMs = 8_000): Promise<string[] | null> {
  try {
    const stdout = await runGit([
      'ls-remote', '--tags', '--refs', githubSshUrl(repo), 'refs/tags/v*',
    ], timeoutMs);
    return stdout.split('\n').flatMap((line) => {
      const match = line.match(/^[0-9a-f]{40}\s+refs\/tags\/(v[^\s]+)$/i);
      return match ? [match[1]] : [];
    });
  } catch {
    return null;
  }
}

/**
 * Fetch only the requested tag objects into a temporary bare repository and
 * read their annotated messages.  GitHub Releases created by release.yml use
 * the annotated tag message as their body, so this reproduces the useful part
 * of the Releases API without HTTPS/API quota.  Lightweight tags fall back to
 * their commit message, which is still better than an empty changelog.
 */
export async function readGithubTagAnnotationsViaSsh(
  repo: string,
  requestedTags: string[],
  timeoutMs = 15_000,
): Promise<Map<string, GithubTagAnnotation> | null> {
  const tags = [...new Set(requestedTags)]
    .filter(tag => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag))
    .slice(0, 50);
  if (tags.length === 0) return new Map();

  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'botmux-github-tags-'));
    await runGit(['init', '--bare', '--quiet', dir], 5_000);
    await runGit([
      '-C', dir,
      'fetch', '--quiet', '--force', '--no-tags', '--filter=blob:none', '--depth=1',
      githubSshUrl(repo),
      ...tags.map(tag => `refs/tags/${tag}:refs/tags/${tag}`),
    ], timeoutMs);

    const result = new Map<string, GithubTagAnnotation>();
    for (const tag of tags) {
      const raw = await runGit([
        '-C', dir,
        'for-each-ref',
        '--format=%(objecttype)%00%(creatordate:iso-strict)%00%(contents)',
        `refs/tags/${tag}`,
      ], 5_000);
      const [objectType = '', createdAt = '', ...bodyParts] = raw.replace(/\n$/, '').split('\0');
      if (!objectType) continue;
      result.set(tag, {
        body: bodyParts.join('\0').trim(),
        createdAt: createdAt.trim() || null,
      });
    }
    return result;
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const defaultGithubGitFallback: GithubGitFallback = {
  readFileAtRef: readGithubFileAtRefViaSsh,
  listTags: listGithubTagsViaSsh,
  readTagAnnotations: readGithubTagAnnotationsViaSsh,
};
