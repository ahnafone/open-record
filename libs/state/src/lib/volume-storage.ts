/**
 * localStorage key for the per-device volume and mute (a convenience, not
 * synced). Shared by `PlayerStore` (local changes) and `SessionStore` (volume
 * applied from a remote controller), so both write the same record.
 */
export const VOLUME_KEY = 'or.volume';

/** Persist the device volume and mute. Best effort: storage may be blocked. */
export function saveVolumeState(volume: number, muted: boolean): void {
  try {
    globalThis.localStorage?.setItem(
      VOLUME_KEY,
      JSON.stringify({ volume, muted }),
    );
  } catch {
    // Best effort.
  }
}
