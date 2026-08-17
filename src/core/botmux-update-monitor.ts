/**
 * Read-only update monitor for the personal Botmux distribution.
 *
 * Only installer-managed releases participate. The `.botmux-install.json`
 * provenance pins the exact personal repo/ref; npm installs remain on the
 * official package channel and local source checkouts remain developer-owned.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fetchLatestVersion, isCanonicalStableVersion, isNewerVersion } from './update-check.js';
import { localeForBot, t, type Locale } from '../i18n/index.js';
import {
  managedSourceInstall,
  PERSONAL_UPDATE_REF,
  PERSONAL_UPDATE_REPO,
  type ManagedSourceInstallInfo,
} from '../utils/install-info.js';

export const BOTMUX_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const BOTMUX_UPDATE_TICK_MS = 60 * 60 * 1_000;
export const BOTMUX_UPDATE_INITIAL_DELAY_MS = 30_000;

export interface BotmuxUpdateState {
  schemaVersion: 1;
  repo: typeof PERSONAL_UPDATE_REPO;
  ref: typeof PERSONAL_UPDATE_REF;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  lastCheckedAt: number;
  lastNotifiedVersion?: string;
}

export interface BotmuxUpdateAuditDeps {
  now: () => number;
  install: () => ManagedSourceInstallInfo | null;
  readState: () => BotmuxUpdateState | null;
  writeState: (state: BotmuxUpdateState) => void;
  fetchLatest: () => Promise<string | null>;
  notify?: (state: BotmuxUpdateState) => Promise<void>;
  log?: (message: string) => void;
}

export interface BotmuxUpdateMonitorWiring {
  dataDir: string;
  primaryLarkAppId: string;
  ownerOpenId: () => string | undefined;
  dashboardUrl?: () => string | undefined;
  sendCard: (openId: string, cardJson: string) => Promise<void>;
  log?: (message: string) => void;
}

const STORE_FILE = 'botmux-updates.json';

export function botmuxUpdateStatePathIn(dataDir: string): string {
  return join(dataDir, STORE_FILE);
}

function validStoredVersion(value: unknown): value is string {
  return typeof value === 'string' && isCanonicalStableVersion(value);
}

export function readBotmuxUpdateStateFrom(dataDir: string): BotmuxUpdateState | null {
  const path = botmuxUpdateStatePathIn(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (raw.schemaVersion !== 1
      || raw.repo !== PERSONAL_UPDATE_REPO
      || raw.ref !== PERSONAL_UPDATE_REF
      || !validStoredVersion(raw.current)
      || (raw.latest !== null && !validStoredVersion(raw.latest))
      || typeof raw.lastCheckedAt !== 'number'
      || !Number.isFinite(raw.lastCheckedAt)
      || (raw.lastNotifiedVersion !== undefined && !validStoredVersion(raw.lastNotifiedVersion))) {
      return null;
    }
    const latest = raw.latest as string | null;
    return {
      schemaVersion: 1,
      repo: PERSONAL_UPDATE_REPO,
      ref: PERSONAL_UPDATE_REF,
      current: raw.current,
      latest,
      // Never trust a persisted derived flag after an upgrade or manual edit.
      updateAvailable: latest !== null && isNewerVersion(latest, raw.current),
      lastCheckedAt: raw.lastCheckedAt,
      ...(typeof raw.lastNotifiedVersion === 'string'
        ? { lastNotifiedVersion: raw.lastNotifiedVersion }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeBotmuxUpdateStateTo(dataDir: string, state: BotmuxUpdateState): void {
  const path = botmuxUpdateStatePathIn(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** One bounded check. Failed lookups retain the last known status but still
 * advance the TTL, preventing an unavailable GitHub endpoint from being hit
 * every hour. The notification watermark advances only after a successful DM. */
export async function runBotmuxUpdateAudit(deps: BotmuxUpdateAuditDeps): Promise<void> {
  const install = deps.install();
  if (!install) return;

  const now = deps.now();
  const previous = deps.readState();
  if (previous
    && previous.current === install.version
    && now - previous.lastCheckedAt < BOTMUX_UPDATE_CHECK_INTERVAL_MS) {
    return;
  }

  const log = deps.log ?? (() => {});
  let latest: string | null = null;
  try {
    latest = await deps.fetchLatest();
    if (latest !== null && !isCanonicalStableVersion(latest)) latest = null;
  } catch (error) {
    log(`check failed: ${error instanceof Error ? error.message : error}`);
  }

  // Reuse the last known target on a transient lookup failure. The comparison
  // is always recomputed against the install metadata read on this tick.
  const effectiveLatest = latest ?? previous?.latest ?? null;
  const next: BotmuxUpdateState = {
    schemaVersion: 1,
    repo: PERSONAL_UPDATE_REPO,
    ref: PERSONAL_UPDATE_REF,
    current: install.version,
    latest: effectiveLatest,
    updateAvailable: effectiveLatest !== null && isNewerVersion(effectiveLatest, install.version),
    lastCheckedAt: now,
    ...(previous?.lastNotifiedVersion
      ? { lastNotifiedVersion: previous.lastNotifiedVersion }
      : {}),
  };
  deps.writeState(next);
  log(`checked personal Botmux: ${next.current}${latest ? ` -> ${latest}` : ' (latest unavailable)'}`);

  if (!next.updateAvailable
    || !next.latest
    || next.lastNotifiedVersion === next.latest
    || !deps.notify) return;
  try {
    await deps.notify(next);
    next.lastNotifiedVersion = next.latest;
    deps.writeState(next);
    log(`owner notified: ${next.current} -> ${next.latest}`);
  } catch (error) {
    log(`owner notification failed: ${error instanceof Error ? error.message : error}`);
  }
}

export function buildBotmuxUpdateCard(
  state: BotmuxUpdateState,
  opts: { dashboardUrl?: string; locale?: Locale } = {},
): string {
  const locale = opts.locale;
  const lines = [
    t('botmux_update.available', undefined, locale),
    t('botmux_update.version_delta', { current: state.current, latest: state.latest ?? '?' }, locale),
    t('botmux_update.source', { repo: state.repo, ref: state.ref }, locale),
    t('botmux_update.command', { command: '`botmux upgrade && botmux restart`' }, locale),
    t('botmux_update.manual_only', undefined, locale),
  ];
  if (opts.dashboardUrl) lines.push(t('botmux_update.dashboard', { url: opts.dashboardUrl }, locale));
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: t('botmux_update.card_title', undefined, locale) },
    },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  });
}

let monitorTimer: NodeJS.Timeout | undefined;
let initialTimer: NodeJS.Timeout | undefined;
let monitorInFlight = false;

/** Start only in the primary daemon. Non-managed installs intentionally do not
 * get a timer: they cannot be proven to belong to the personal release stream. */
export function startBotmuxUpdateMonitor(wiring: BotmuxUpdateMonitorWiring): void {
  if (monitorTimer || initialTimer) return;
  const log = wiring.log ?? (() => {});
  if (!managedSourceInstall()) {
    log('timer skipped (not an installer-managed personal build)');
    return;
  }

  const tick = async () => {
    if (monitorInFlight) return;
    monitorInFlight = true;
    try {
      await runBotmuxUpdateAudit({
        now: () => Date.now(),
        install: managedSourceInstall,
        readState: () => readBotmuxUpdateStateFrom(wiring.dataDir),
        writeState: state => writeBotmuxUpdateStateTo(wiring.dataDir, state),
        fetchLatest: () => fetchLatestVersion(),
        notify: async state => {
          const owner = wiring.ownerOpenId();
          if (!owner) throw new Error('no primary owner configured');
          await wiring.sendCard(owner, buildBotmuxUpdateCard(state, {
            dashboardUrl: wiring.dashboardUrl?.(),
            locale: localeForBot(wiring.primaryLarkAppId),
          }));
        },
        log,
      });
    } catch (error) {
      log(`audit failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      monitorInFlight = false;
    }
  };

  initialTimer = setTimeout(() => {
    initialTimer = undefined;
    void tick();
  }, BOTMUX_UPDATE_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  monitorTimer = setInterval(() => { void tick(); }, BOTMUX_UPDATE_TICK_MS);
  monitorTimer.unref?.();
  log('timer started (primary daemon, read-only daily audit)');
}

export function stopBotmuxUpdateMonitor(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (monitorTimer) clearInterval(monitorTimer);
  initialTimer = undefined;
  monitorTimer = undefined;
  monitorInFlight = false;
}
