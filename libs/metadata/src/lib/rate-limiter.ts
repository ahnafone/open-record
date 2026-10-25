export interface RateLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Serial FIFO queue that starts at most one task per `intervalMs`.
 * A failing task never blocks the tasks queued behind it.
 */
export class RateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs = 1000,
    private readonly clock: RateLimiterClock = realClock,
  ) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const wait = this.lastStart + this.intervalMs - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      this.lastStart = this.clock.now();
      return task();
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
