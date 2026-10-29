import { newClientId, newEntryId } from '@open-record/models';
import { SETTINGS_KEYS, type StoragePort } from '@open-record/storage';

/** Longest device name the picker shows. */
export const MAX_DEVICE_NAME_LENGTH = 60;

/**
 * Last resort when storage cannot be read or written. Deliberately only kept
 * after a failure: if storage is merely empty (app data cleared), the next
 * call generates and persists a brand-new id instead of reusing this one.
 */
let fallbackDeviceId: string | undefined;

/**
 * The stable per-install device id. Reads the persisted value, or generates
 * and persists one when it is missing. Falls back to an in-memory id only
 * while storage is failing, so clearing app data still yields a new id.
 */
export async function ensureDeviceId(
  storage: Pick<StoragePort, 'settings'>,
): Promise<string> {
  try {
    const stored: unknown = await storage.settings.get(SETTINGS_KEYS.deviceId);
    if (typeof stored === 'string' && stored.trim()) return stored.trim();
  } catch {
    // Unreadable storage: keep one id for the life of this process.
    fallbackDeviceId ??= newEntryId();
    return fallbackDeviceId;
  }
  // A previous write failed. Keep that id even now that reads work again,
  // instead of minting a fresh one on every call.
  if (fallbackDeviceId) return fallbackDeviceId;
  const id = newEntryId();
  try {
    await storage.settings.set(SETTINGS_KEYS.deviceId, id);
  } catch {
    // Writable storage returned to a failed state: keep it in memory.
    fallbackDeviceId = id;
  }
  return id;
}

/**
 * A per-instance client id: one per `SessionStore` (tab or app launch).
 * Never persisted, so two tabs are two distinct session devices.
 */
export function ensureClientId(): string {
  return newClientId();
}

/**
 * A sensible name for the device picker, based on the platform in the user
 * agent. Always short enough for the UI (<= 60 characters).
 */
export function defaultDeviceName(
  nav:
    | Pick<Navigator, 'userAgent' | 'platform'>
    | undefined = globalThis.navigator,
): string {
  const source = `${nav?.userAgent ?? ''} ${nav?.platform ?? ''}`;
  let name = 'Web browser';
  if (/android/i.test(source)) name = 'Android device';
  else if (/iphone/i.test(source)) name = 'iPhone';
  else if (/ipad/i.test(source)) name = 'iPad';
  else if (/macintosh|mac os x|macintel/i.test(source)) name = 'Mac';
  else if (/windows|win32|win64/i.test(source)) name = 'Windows PC';
  else if (/linux/i.test(source)) name = 'Linux computer';
  return name.slice(0, MAX_DEVICE_NAME_LENGTH);
}
