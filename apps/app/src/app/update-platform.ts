import { Capacitor } from '@capacitor/core';
import type { UpdatePlatform } from '@open-record/state';
import { getDesktopBridge } from './desktop-bridge';
import { createAndroidUpdatePlatform } from './update-platform-android';
import { createElectronUpdatePlatform } from './update-platform-electron';

/**
 * The update adapter for this build: Electron inside the desktop app, the
 * Android app on Android, else `null` (web and iOS: notify only or nothing).
 */
export function createUpdatePlatform(): UpdatePlatform | null {
  if (getDesktopBridge() !== null) return createElectronUpdatePlatform();
  if (Capacitor.getPlatform() === 'android') return createAndroidUpdatePlatform();
  return null;
}
