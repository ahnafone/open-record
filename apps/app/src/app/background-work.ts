import { Capacitor, registerPlugin } from '@capacitor/core';
import { BackgroundWorkPort } from '@open-record/state';

/**
 * App-local Android plugin (`BackgroundWorkPlugin.java`) running a dataSync
 * foreground service with wake and Wi-Fi locks, so downloads keep going
 * with the screen off.
 */
interface BackgroundWorkPlugin {
  start(options: { title: string; text: string }): Promise<void>;
  update(options: { text: string }): Promise<void>;
  stop(): Promise<void>;
}

/** `NotificationPermissionPlugin.java`: POST_NOTIFICATIONS on Android 13+. */
interface NotificationPermissionPlugin {
  request(): Promise<{ granted: boolean }>;
}

const PLUGIN = 'BackgroundWork';
const PERMISSION_PLUGIN = 'NotificationPermission';

/** Android: the foreground-service plugin (registered on first use). Never rejects. */
class AndroidBackgroundWork extends BackgroundWorkPort {
  private plugin?: BackgroundWorkPlugin;
  private permission?: Promise<void>;

  private get native(): BackgroundWorkPlugin {
    this.plugin ??= registerPlugin<BackgroundWorkPlugin>(PLUGIN);
    return this.plugin;
  }

  /** Ask once per run; the service still runs if denied (the notification is just hidden). */
  private requestPermission(): Promise<void> {
    this.permission ??= (async () => {
      if (!Capacitor.isPluginAvailable(PERMISSION_PLUGIN)) return;
      try {
        await registerPlugin<NotificationPermissionPlugin>(PERMISSION_PLUGIN).request();
      } catch {
        // Denied or unavailable: keep going without a visible notification.
      }
    })();
    return this.permission;
  }

  async start(options: { title: string; text: string }): Promise<void> {
    await this.requestPermission();
    try {
      await this.native.start(options);
    } catch {
      // Android refused (e.g. started from the background): downloads still run while open.
    }
  }

  async update(options: { text: string }): Promise<void> {
    try {
      await this.native.update(options);
    } catch {
      // Not running: nothing to update.
    }
  }

  async stop(): Promise<void> {
    try {
      await this.native.stop();
    } catch {
      // Already stopped.
    }
  }
}

/** Android with the plugin: the foreground service; web, iOS or an older build: null (no hold). */
export function createBackgroundWork(): BackgroundWorkPort | null {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable(PLUGIN)
    ? new AndroidBackgroundWork()
    : null;
}
