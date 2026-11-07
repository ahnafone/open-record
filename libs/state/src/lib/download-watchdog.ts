/** How often the watchdog checks download progress while downloads are wanted. */
export const WATCHDOG_INTERVAL_MS = 30_000;
/** No progress for this long while downloads are wanted counts as a stall. */
export const WATCHDOG_STALL_MS = 2 * 60_000;
/** Restarts without a finished save before the watchdog gives up and says so. */
export const MAX_WATCHDOG_RESTARTS = 3;
/**
 * After a resume, progress is judged this long later: the WebView may still be
 * waking up and the progress ticks that arrive first should count as movement.
 */
export const RESUME_GRACE_MS = 5_000;
/** A gap this long between checks means JS was frozen (e.g. screen off), not a stall. */
export const FROZEN_GAP_MS = 3 * WATCHDOG_INTERVAL_MS;

/** User-facing pause text when the watchdog gives up restarting. */
export const WATCHDOG_STALLED_REASON =
  'Downloads keep stalling. Check your connection or battery settings.';

export interface DownloadWatchdogOptions {
  /** Downloads are wanted and may run right now. */
  wanted(): boolean;
  /**
   * A value that changes whenever downloads move. `null` means no running save
   * has reported progress, so there is nothing to judge (e.g. saves without a
   * content length never tick).
   */
  marker(): string | null;
  /** Saves finished so far. An increase is real progress and resets the restart count. */
  completed(): number;
  /** Abort silent saves and restart the download run. */
  restart(): void;
  /** Too many restarts without progress: stop restarting and surface it. */
  giveUp(): void;
}

/**
 * Detects a download run that stopped moving (the WebView or JS is throttled
 * while the screen is off) and restarts it. Checks every `WATCHDOG_INTERVAL_MS`
 * while started; `start`/`stop` follow whether downloads are wanted. A change
 * of the marker (a progress tick) restarts the stall window, but only a finished
 * save resets the restart count. After `MAX_WATCHDOG_RESTARTS` restarts without
 * a finished save it gives up (until `rearm`).
 */
export class DownloadWatchdog {
  private timer: ReturnType<typeof setInterval> | undefined;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;
  private marker: string | null = null;
  private completed = 0;
  private movedAt = 0;
  private lastCheck = 0;
  private restarts = 0;
  private gaveUp = false;

  constructor(private readonly options: DownloadWatchdogOptions) {}

  /** Watch progress while downloads are wanted. Safe to call repeatedly. */
  start(): void {
    if (this.timer !== undefined || this.gaveUp) return;
    const now = Date.now();
    this.marker = this.options.marker();
    this.movedAt = now;
    this.lastCheck = now;
    this.timer = setInterval(() => this.check(), WATCHDOG_INTERVAL_MS);
  }

  /** Stop watching (nothing wanted, or destroyed). Keeps the restart count. */
  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.resumeTimer);
    this.timer = undefined;
    this.resumeTimer = undefined;
    this.marker = null;
  }

  /** The user retried downloads: forget past stalls and judge progress afresh. */
  rearm(): void {
    this.restarts = 0;
    this.reenable();
  }

  /**
   * The run was un-paused by something other than the user (network change, a
   * retry timer): lift a give-up but keep the restart count, so a stall right
   * away gives up again instead of restarting forever.
   */
  reenable(): void {
    this.gaveUp = false;
    if (this.options.wanted()) this.start();
  }

  /** The app came back to the foreground: judge progress shortly. No-op unless watching. */
  resumed(): void {
    if (this.timer === undefined) return;
    // Judge from the resume, not from a baseline taken before the screen went off.
    this.movedAt = Date.now();
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      this.check();
    }, RESUME_GRACE_MS);
  }

  /** One check: called by the interval and after a resume. */
  check(): void {
    if (!this.options.wanted()) {
      this.stop();
      return;
    }
    const now = Date.now();
    // A long gap since the last check means JS was frozen: judge nothing this time.
    const frozen = now - this.lastCheck > FROZEN_GAP_MS;
    this.lastCheck = now;
    // Only a finished save is real progress: it resets the restart count.
    const completed = this.options.completed();
    if (completed > this.completed) {
      this.completed = completed;
      this.restarts = 0;
    }
    const marker = this.options.marker();
    if (frozen || marker === null) {
      this.marker = marker;
      this.movedAt = now;
      return;
    }
    // Ticks move the stall window but not the restart count.
    if (marker !== this.marker) {
      this.marker = marker;
      this.movedAt = now;
      return;
    }
    if (now - this.movedAt < WATCHDOG_STALL_MS) return;
    if (this.restarts >= MAX_WATCHDOG_RESTARTS) {
      this.gaveUp = true;
      this.stop();
      this.options.giveUp();
      return;
    }
    this.restarts += 1;
    // The restart gets a full stall window before it is judged.
    this.movedAt = now;
    this.options.restart();
  }
}
