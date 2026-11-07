import { Injectable, inject } from '@angular/core';
import { SETTINGS_KEYS, StoragePort } from '@open-record/storage';
import { BackgroundWorkPort } from './ports';

/**
 * Copy for the battery-optimization prompt. Structurally the same as the UI's
 * `ConfirmOptions`, so a page passes it straight to `OrDialog.confirm`.
 */
export interface BatteryPromptOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

export const BATTERY_PROMPT: BatteryPromptOptions = {
  title: 'Keep downloads running?',
  message:
    "Open Record is going to download songs in the background. Please turn off battery optimization for the app so downloads don't stall when your screen is off.",
  confirmLabel: 'Continue',
  cancelLabel: 'Not now',
};

/** After "Not now" (or a denied system dialog), the prompt is not offered again for this long. */
export const BATTERY_PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Asks Android to exempt the app from battery optimization when an auto-download
 * switch is turned on, so downloads keep running with the screen off. Shared by
 * the Library and playlist switches. Never rejects.
 */
@Injectable({ providedIn: 'root' })
export class BatteryExemptionStore {
  private readonly storage = inject(StoragePort);
  private readonly background = inject(BackgroundWorkPort, { optional: true });

  /**
   * Call when an auto-download switch is turned on. `ask` shows the prompt and
   * resolves true on "Continue". No prompt when the platform cannot report
   * exemption (web, iOS), the app is already exempt, or the user declined
   * (Not now, or the system dialog left the app not exempt) within the
   * cooldown. Resolves once the answer is handled, including the system
   * dialog. Callers must not await it before saving the switch: the switch is
   * persisted first and this runs afterwards.
   */
  async offerOnSwitchOn(
    ask: (options: BatteryPromptOptions) => Promise<boolean>,
  ): Promise<void> {
    try {
      const port = this.background ?? null;
      if (!port) return;
      // Only an explicit "not exempt" prompts; true or unknown (null) does not.
      if ((await port.isIgnoringBatteryOptimizations()) !== false) return;
      const declinedAt = await this.storage.settings.get<number>(
        SETTINGS_KEYS.batteryPromptDeclinedAt,
      );
      if (
        typeof declinedAt === 'number' &&
        Date.now() - declinedAt < BATTERY_PROMPT_COOLDOWN_MS
      ) {
        return;
      }
      if (await ask(BATTERY_PROMPT)) {
        await port.requestIgnoreBatteryOptimizations();
        // Still not exempt after the system dialog: a denial, so no re-ask during the cooldown.
        if ((await port.isIgnoringBatteryOptimizations()) === false) {
          await this.recordDecline();
        }
      } else {
        await this.recordDecline();
      }
    } catch {
      // Prompt or storage failed: the switch still turns on.
    }
  }

  private async recordDecline(): Promise<void> {
    await this.storage.settings.set(
      SETTINGS_KEYS.batteryPromptDeclinedAt,
      Date.now(),
    );
  }
}
