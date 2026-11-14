import {
  Capacitor,
  WebPlugin,
  registerPlugin,
  type PluginListenerHandle,
} from '@capacitor/core';

/**
 * App-local Android plugin (`SystemVolumePlugin.java` in apps/app/android).
 * Controls the music-stream volume as a 0..1 fraction.
 */
export interface SystemVolumePlugin {
  /**
   * Current STREAM_MUSIC volume, 0..1. `fixed` is true when the OS does not
   * allow the app to change it (`AudioManager.isVolumeFixed`).
   */
  getVolume(): Promise<{ volume: number; fixed?: boolean }>;
  /** Sets STREAM_MUSIC volume, 0..1, without showing system UI. */
  setVolume(opts: { volume: number }): Promise<void>;
  /**
   * When enabled, hardware volume up/down keys do not change the system
   * volume and fire `volumeKey` instead.
   */
  setKeyIntercept(opts: { enabled: boolean }): Promise<void>;
  addListener(
    event: 'volumeChanged',
    cb: (e: { volume: number }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'volumeKey',
    cb: (e: { direction: 'up' | 'down' }) => void,
  ): Promise<PluginListenerHandle>;
}

/** Harmless web fallback: the system volume is not controllable in a browser. */
class SystemVolumeWeb extends WebPlugin {
  async getVolume(): Promise<{ volume: number }> {
    return { volume: 1 };
  }

  async setVolume(): Promise<void> {
    // No-op on web.
  }

  async setKeyIntercept(): Promise<void> {
    // No-op on web.
  }
}

export const SystemVolume = registerPlugin<SystemVolumePlugin>('SystemVolume', {
  web: () => Promise.resolve(new SystemVolumeWeb()),
});

/** True only on Android, where the native SystemVolume plugin exists. */
export const isAndroidSystemVolumeAvailable = (): boolean =>
  Capacitor.getPlatform() === 'android';
