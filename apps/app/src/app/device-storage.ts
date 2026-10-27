import { Capacitor, registerPlugin } from '@capacitor/core';
import type { DownloadLocation } from '@open-record/models';
import type { DeviceStoragePort } from '@open-record/state';

/**
 * App-local native plugin (`DeviceStoragePlugin.java` on Android,
 * `DeviceStoragePlugin.swift` on iOS) reporting free/total bytes on the
 * volume behind a download location.
 */
interface DeviceStoragePlugin {
  space(options: { location: DownloadLocation }): Promise<{ freeBytes: number; totalBytes?: number }>;
}

const PLUGIN = 'DeviceStorage';

/** Native: asks the plugin. Web or an older native build: always `null`. */
export function createDeviceStorage(): DeviceStoragePort {
  const plugin =
    Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(PLUGIN)
      ? registerPlugin<DeviceStoragePlugin>(PLUGIN)
      : null;
  const native = Capacitor.isNativePlatform();
  return {
    native,
    // iOS keeps Data and Documents in the same folder, so only Android offers a choice.
    locations: native && Capacitor.getPlatform() === 'android' ? ['data', 'external'] : ['data'],
    async space(location) {
      if (!plugin) return null;
      try {
        const out = await plugin.space({ location });
        if (!Number.isFinite(out.freeBytes) || out.freeBytes < 0) return null;
        return Number.isFinite(out.totalBytes) && (out.totalBytes ?? 0) > 0
          ? { freeBytes: out.freeBytes, totalBytes: out.totalBytes }
          : { freeBytes: out.freeBytes };
      } catch {
        return null;
      }
    },
  };
}
