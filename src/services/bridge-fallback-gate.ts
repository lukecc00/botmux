/**
 * Decision logic for "should the worker suppress its transcript-driven
 * fallback emit for this Lark turn?"
 *
 * Pure function with no I/O — kept separate from worker.ts so the rules
 * (including the type-ahead window and the adopt-vs-non-adopt branching)
 * can be tested deterministically. The worker reads marker entries from
 * disk and threads them through here.
 *
 * Rules:
 *   - Adopt mode never suppresses: in /adopt the model in the adopted
 *     session is unaware of botmux, so transcript drain is the ONLY
 *     channel from model to Lark. There's no `botmux send` to compete
 *     with, hence no marker to gate on.
 *   - Non-adopt + isLocal: suppress. A local-typing turn means the
 *     attribution queue saw a user event whose content didn't match any
 *     pending Lark fingerprint. In a worker-spawned CLI that's a Web
 *     terminal hand-typed input — the user is already looking at it, no
 *     reason to push it back to the Lark thread.
 *   - Non-adopt + send observed in window: suppress. The window is
 *     [turn.markTimeMs, nextBoundaryMs). Legacy markers only carry time,
 *     so any marker in the window still suppresses. Newer markers carry the
 *     normalized length of the explicit `botmux send` body. When the
 *     transcript final is available, only emit fallback if that final is
 *     materially longer than any single explicit send in the same window.
 *     This lets short progress updates surface a later substantive final
 *     answer, while same-size rewrites and short acknowledgements stay
 *     suppressed. Boundary handling intentionally also considers
 *     queue items that haven't reached "ready" yet (passed in via
 *     nextBoundaryMs) — without that, a model that's still mid-tool-use
 *     for turn N+1 could leak a send credit into turn N's window.
 */
import { createHash } from 'node:crypto';
import { normaliseForFingerprint } from './bridge-turn-queue.js';

const MATERIAL_FINAL_LENGTH_RATIO = 2;
const MATERIAL_FINAL_MIN_EXTRA_CHARS = 120;

export interface BridgeSendMarker {
  sentAtMs: number;
  messageId?: string;
  contentLength?: number;
  /** Stable digest of the normalized body. Lets the final fallback distinguish
   * a manually mirrored commentary send from a send of the final answer. */
  contentHash?: string;
}

export interface BridgeGateInput {
  /** When the user message was queued — defines the lower bound of the
   *  send window. Undefined for legacy turns; the gate degrades to
   *  "never suppress" in that case. */
  markTimeMs: number | undefined;
  /** Whether the queue synthesised this turn from a local-terminal event
   *  (no fingerprint match for a Lark message). */
  isLocal: boolean | undefined;
  /** Transcript final text for this turn, when available. Lets structured
   *  send markers distinguish final-answer sends from earlier progress sends. */
  finalText?: string;
  /** Transcript-native commentary emitted earlier in this exact turn. A
   *  matching explicit send is only the required progress mirror and must not
   *  consume the later final-answer fallback. */
  progressTexts?: readonly string[];
}

function bridgeContentHash(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function buildBridgeSendMarkerContent(content: string): Pick<BridgeSendMarker, 'contentLength' | 'contentHash'> | undefined {
  const normalized = normaliseForFingerprint(content);
  if (!normalized) return undefined;
  return { contentLength: normalized.length, contentHash: bridgeContentHash(normalized) };
}

type StructuredBridgeSendMarker = BridgeSendMarker & {
  contentLength: number;
};

function hasStructuredContentMarker(marker: BridgeSendMarker): marker is StructuredBridgeSendMarker {
  return typeof marker.contentLength === 'number';
}

function finalIsMateriallyLongerThanSends(finalLength: number, markers: readonly StructuredBridgeSendMarker[]): boolean {
  const maxSentLength = markers.reduce((max, marker) => Math.max(max, marker.contentLength), 0);
  return finalLength >= maxSentLength * MATERIAL_FINAL_LENGTH_RATIO
    && finalLength - maxSentLength >= MATERIAL_FINAL_MIN_EXTRA_CHARS;
}

function markerSetCoversFinal(
  markers: readonly BridgeSendMarker[],
  finalText: string | undefined,
  progressTexts: readonly string[] | undefined,
): boolean {
  if (markers.length === 0) return false;

  const normalizedProgress = (progressTexts ?? [])
    .map(text => normaliseForFingerprint(text))
    .filter(Boolean);
  const progressHashes = new Set(normalizedProgress.map(bridgeContentHash));
  const progressLengths = new Set(normalizedProgress.map(text => text.length));
  const finalMarkers = markers.filter(marker => {
    if (marker.contentHash) return !progressHashes.has(marker.contentHash);
    // Rolling-upgrade compatibility: older CLI markers only contain the
    // normalized body length.  An exact commentary-length hit is sufficient
    // to identify the required mirror as progress, while any unmatched legacy
    // marker stays conservative and may still suppress to avoid duplicate
    // finals.  Hash-bearing markers remain the authoritative path.
    return marker.contentLength === undefined || !progressLengths.has(marker.contentLength);
  });
  if (finalMarkers.length === 0) return false;

  // Back-compat: old marker files only have sentAtMs/messageId. Keep the old
  // conservative behavior for those entries instead of risking duplicates.
  if (finalMarkers.some(m => !hasStructuredContentMarker(m))) return true;

  const finalNormalized = normaliseForFingerprint(finalText ?? '');
  if (!finalNormalized) return true;

  const structuredMarkers = finalMarkers.filter(hasStructuredContentMarker);
  return !finalIsMateriallyLongerThanSends(finalNormalized.length, structuredMarkers);
}

export function shouldSuppressBridgeEmit(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
): boolean {
  if (adoptMode) return false;
  if (turn.isLocal) return true;
  if (turn.markTimeMs === undefined) return false;
  const lower = turn.markTimeMs;
  const upper = nextBoundaryMs ?? Number.POSITIVE_INFINITY;
  const markersInWindow = markers.filter(m => m.sentAtMs >= lower && m.sentAtMs < upper);
  return markerSetCoversFinal(markersInWindow, turn.finalText, turn.progressTexts);
}
