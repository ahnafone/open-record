/** Thrown when every yt-dlp slot and queue place is taken; answered as 503. */
export class ResolverBusyError extends Error {
  readonly status = 503;

  constructor() {
    super('server is busy resolving other links, try again shortly');
  }
}

export interface LimiterOptions {
  /** Tasks allowed to run at once. */
  max: number;
  /** Tasks allowed to wait for a slot; more than this is rejected immediately. */
  maxQueue: number;
  /** How long a queued task waits for a slot before it is rejected. */
  waitMs: number;
}

export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** Counting semaphore with a bounded FIFO wait queue. */
export function createLimiter({ max, maxQueue, waitMs }: LimiterOptions): Limiter {
  let active = 0;
  const waiting: { wake: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

  const release = (): void => {
    active--;
    const next = waiting.shift();
    if (next) {
      active++; // the slot passes straight to the next waiter
      clearTimeout(next.timer);
      next.wake();
    }
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= max) {
        if (waiting.length >= maxQueue) throw new ResolverBusyError();
        await new Promise<void>((resolve, reject) => {
          const entry = {
            wake: resolve,
            timer: setTimeout(() => {
              const i = waiting.indexOf(entry);
              if (i >= 0) waiting.splice(i, 1);
              reject(new ResolverBusyError());
            }, waitMs),
          };
          waiting.push(entry);
        });
      } else {
        active++;
      }
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
