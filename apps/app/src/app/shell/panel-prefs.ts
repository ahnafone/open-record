/**
 * Per-device memory for the desktop Now Playing side panel: whether it is
 * open and how wide it is. Persisted in localStorage next to `or.volume`,
 * best effort only: blocked or corrupt storage never throws and falls back
 * to the defaults.
 */

/** Whether the desktop Now Playing panel is open (`'1'`) or closed (`'0'`). */
const OPEN_KEY = 'or.nowPlaying.open';
/** Panel width in CSS pixels, as a plain integer string. */
const WIDTH_KEY = 'or.nowPlaying.width';

/** Width used on first open, on double-click reset and for invalid values. */
export const NOW_PLAYING_DEFAULT_WIDTH = 360;
/** Narrowest usable side panel. */
export const NOW_PLAYING_MIN_WIDTH = 280;
/** Widest side panel, even on very wide screens. */
export const NOW_PLAYING_MAX_WIDTH = 600;
/** Arrow-key resize step. */
export const NOW_PLAYING_KEY_STEP = 16;
/** Shift+Arrow-key resize step. */
export const NOW_PLAYING_SHIFT_STEP = 64;
/** Desktop left navigation column width the panel must leave room for. */
export const NOW_PLAYING_LEFT_NAV_RESERVE = 248;
/** Content width the panel must leave beside it. */
export const NOW_PLAYING_MIN_CONTENT_RESERVE = 240;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // Storage can be blocked outright (privacy modes, sandboxed iframes).
    return undefined;
  }
}

/** The panel remembers its open state; default closed. */
export function readNowPlayingPanelOpen(): boolean {
  try {
    return storage()?.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeNowPlayingPanelOpen(open: boolean): void {
  try {
    storage()?.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // Best effort.
  }
}

/**
 * Width cap for a viewport: leave the left nav and a readable content column
 * beside the panel, never narrower than the minimum and never wider than the
 * maximum. A missing/invalid viewport width is treated as unbounded.
 */
export function maxNowPlayingPanelWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return NOW_PLAYING_MAX_WIDTH;
  }
  const available =
    viewportWidth -
    NOW_PLAYING_LEFT_NAV_RESERVE -
    NOW_PLAYING_MIN_CONTENT_RESERVE;
  return Math.max(
    NOW_PLAYING_MIN_WIDTH,
    Math.min(NOW_PLAYING_MAX_WIDTH, available),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds and clamps a wanted width to the current viewport. */
export function clampNowPlayingPanelWidth(
  width: number,
  viewportWidth: number,
): number {
  return Math.round(
    clamp(width, NOW_PLAYING_MIN_WIDTH, maxNowPlayingPanelWidth(viewportWidth)),
  );
}

/** The remembered width, or the default; always rounded and clamped. */
export function readNowPlayingPanelWidth(viewportWidth: number): number {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(WIDTH_KEY) ?? null;
  } catch {
    // Fall through to the default.
  }
  const text = raw?.trim() ?? '';
  const parsed = text ? Number(text) : Number.NaN;
  const width = Number.isFinite(parsed) ? parsed : NOW_PLAYING_DEFAULT_WIDTH;
  return clampNowPlayingPanelWidth(width, viewportWidth);
}

export function writeNowPlayingPanelWidth(width: number): void {
  try {
    storage()?.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Best effort.
  }
}
