import {
  DownloadWatchdog,
  MAX_WATCHDOG_RESTARTS,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_STALL_MS,
} from './download-watchdog';

function setup() {
  const state = { wanted: true, marker: 'a' as string | null, completed: 0 };
  const restart = vi.fn();
  const giveUp = vi.fn();
  const watchdog = new DownloadWatchdog({
    wanted: () => state.wanted,
    marker: () => state.marker,
    completed: () => state.completed,
    restart,
    giveUp,
  });
  return { state, restart, giveUp, watchdog };
}

describe('download watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('restarts once when the marker does not move for the stall window', () => {
    const { restart, watchdog } = setup();
    watchdog.start();
    vi.advanceTimersByTime(WATCHDOG_STALL_MS + WATCHDOG_INTERVAL_MS);
    expect(restart).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it('does not restart while the marker keeps moving', () => {
    const { state, restart, watchdog } = setup();
    watchdog.start();
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      state.marker = `m${i}`;
    }
    expect(restart).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it('stops restarting after repeated restarts without progress', () => {
    const { restart, giveUp, watchdog } = setup();
    watchdog.start();
    vi.advanceTimersByTime(WATCHDOG_STALL_MS * (MAX_WATCHDOG_RESTARTS + 2));
    expect(restart).toHaveBeenCalledTimes(MAX_WATCHDOG_RESTARTS);
    expect(giveUp).toHaveBeenCalledTimes(1);
    // Given up: no more restarts, and no timer left running.
    vi.advanceTimersByTime(WATCHDOG_STALL_MS * 4);
    expect(restart).toHaveBeenCalledTimes(MAX_WATCHDOG_RESTARTS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a restart that gets one tick and stalls again still gives up', () => {
    const { state, restart, giveUp, watchdog } = setup();
    watchdog.start();
    vi.advanceTimersByTime(WATCHDOG_STALL_MS + WATCHDOG_INTERVAL_MS);
    expect(restart).toHaveBeenCalledTimes(1);
    // One tick after the restart moves the marker, but no save finishes.
    state.marker = 'a1';
    vi.advanceTimersByTime(WATCHDOG_STALL_MS * (MAX_WATCHDOG_RESTARTS + 2));
    expect(restart).toHaveBeenCalledTimes(MAX_WATCHDOG_RESTARTS);
    expect(giveUp).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it('a finished save resets the restart count', () => {
    const { state, restart, giveUp, watchdog } = setup();
    watchdog.start();
    // Use up every restart without progress.
    vi.advanceTimersByTime(WATCHDOG_STALL_MS * MAX_WATCHDOG_RESTARTS);
    expect(restart).toHaveBeenCalledTimes(MAX_WATCHDOG_RESTARTS);
    // A save finishes: the cap is fresh, so the next stalls restart again.
    state.completed = 1;
    state.marker = 'a1';
    vi.advanceTimersByTime(WATCHDOG_STALL_MS * MAX_WATCHDOG_RESTARTS + WATCHDOG_INTERVAL_MS);
    expect(restart).toHaveBeenCalledTimes(MAX_WATCHDOG_RESTARTS * 2);
    expect(giveUp).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it('does nothing and holds no timer while nothing is wanted', () => {
    const { state, restart, watchdog } = setup();
    state.wanted = false;
    watchdog.start();
    watchdog.check();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(WATCHDOG_STALL_MS * 3);
    expect(restart).not.toHaveBeenCalled();
  });
});
