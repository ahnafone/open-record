/**
 * Per-device memory for the web welcome modal: once dismissed it stays
 * dismissed. Persisted in localStorage, best effort only: blocked or missing
 * storage never throws; the modal then shows once per app load.
 */

/** `'1'` once the welcome modal has been dismissed on this device. */
const DISMISSED_KEY = 'or.welcome.dismissed';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // Storage can be blocked outright (privacy modes, sandboxed iframes).
    return undefined;
  }
}

export function readWelcomeDismissed(): boolean {
  try {
    return storage()?.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeWelcomeDismissed(): void {
  try {
    storage()?.setItem(DISMISSED_KEY, '1');
  } catch {
    // Best effort: the modal may show again on a later visit.
  }
}
