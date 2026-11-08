import { createFixedWindow } from './fixed-window';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Hard cap on client keys tracked per window (same bound as the auth counter). */
const GUEST_KEYS_MAX = 10_000;

export interface GuestLimitOptions {
  /** Guest requests allowed per minute per client. */
  perMinute: number;
  /** Guest requests allowed per day per client. */
  perDay: number;
  /** Guest requests allowed per minute across ALL clients (bounds many-address evasion). */
  globalPerMinute: number;
  now?: () => number;
}

/** Why a guest request was refused: which window ran out, and seconds until it resets. */
export interface GuestRefusal {
  window: 'minute' | 'global' | 'day';
  retryAfter: number;
}

/** Counts one guest request for `key`; returns the refusal, or null when allowed. */
export type GuestLimiter = (key: string) => GuestRefusal | null;

/** Single key for the global counter. */
const GLOBAL_KEY = 'all';

/**
 * Per-client guest budget plus a global cap over three windows: the client's
 * minute window, the global minute window and the client's day cap. All three
 * are checked first (peek, nothing counted); only when none refuses is each one
 * counted. So a request refused by any window spends nothing from any of them:
 * a minute refusal does not use up the day's budget, and a day refusal does
 * not use up the shared global budget.
 *
 * Refusal order for reporting is minute, global, day.
 */
export function createGuestLimiter({ perMinute, perDay, globalPerMinute, now }: GuestLimitOptions): GuestLimiter {
  const minute = createFixedWindow({ max: perMinute, windowMs: MINUTE_MS, maxKeys: GUEST_KEYS_MAX, now });
  const global = createFixedWindow({ max: globalPerMinute, windowMs: MINUTE_MS, maxKeys: 1, now });
  const day = createFixedWindow({ max: perDay, windowMs: DAY_MS, maxKeys: GUEST_KEYS_MAX, now });
  return (key) => {
    const minuteWait = minute.peek(key);
    if (minuteWait > 0) return { window: 'minute', retryAfter: minuteWait };
    const globalWait = global.peek(GLOBAL_KEY);
    if (globalWait > 0) return { window: 'global', retryAfter: globalWait };
    const dayWait = day.peek(key);
    if (dayWait > 0) return { window: 'day', retryAfter: dayWait };
    // Nothing refused, so counting cannot be refused now: spend all three.
    minute(key);
    global(GLOBAL_KEY);
    day(key);
    return null;
  };
}
