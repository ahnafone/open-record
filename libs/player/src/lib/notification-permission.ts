import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * App-local Android plugin (`NotificationPermissionPlugin.java` in
 * apps/app/android) that requests POST_NOTIFICATIONS. Android 13+ hides the
 * background-playback notification without it; playback itself still works.
 */
interface NotificationPermissionPlugin {
  request(): Promise<{ granted: boolean }>;
}

export const NOTIFICATION_PERMISSION_PLUGIN = 'NotificationPermission';

/** Requests the permission at most once per app run. */
export type NotificationPermissionRequester = () => Promise<void>;

let pending: Promise<void> | null = null;

/**
 * Asks for notification permission on Android (once per run). Never throws
 * and never blocks playback on a denial; no-op elsewhere.
 */
export const requestPlaybackNotificationPermission: NotificationPermissionRequester =
  () => {
    pending ??= (async () => {
      if (
        Capacitor.getPlatform() !== 'android' ||
        !Capacitor.isPluginAvailable(NOTIFICATION_PERMISSION_PLUGIN)
      ) {
        return;
      }
      try {
        await registerPlugin<NotificationPermissionPlugin>(
          NOTIFICATION_PERMISSION_PLUGIN,
        ).request();
      } catch {
        // Denied or unavailable: playback continues without a notification.
      }
    })();
    return pending;
  };
