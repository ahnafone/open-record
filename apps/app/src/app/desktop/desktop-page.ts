import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  OrButton,
  OrEmptyState,
  OrIcon,
  OrSectionHead,
  OrSpinner,
  OrSwitch,
  OrToast,
} from '@open-record/ui';
import * as QRCode from 'qrcode';
import {
  getDesktopBridge,
  type DesktopStatus,
  type SupabaseConfigInput,
} from '../desktop-bridge';

/**
 * In-app desktop setup: the Supabase project, the LAN toggle and QR for
 * phones, and the bundled server (status, data folder, restart, guide).
 *
 * Only reachable in the Electron app where the preload bridge exists; on the
 * web it explains that the settings live in the desktop app. Secrets are only
 * ever sent to the main process, never displayed or logged.
 */
@Component({
  selector: 'or-desktop-page',
  imports: [
    OrButton,
    OrEmptyState,
    OrIcon,
    OrSectionHead,
    OrSpinner,
    OrSwitch,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './desktop-page.html',
  styleUrl: './desktop-page.css',
})
export class DesktopPage {
  private readonly bridge = getDesktopBridge();
  private readonly toast = inject(OrToast);
  private readonly document = inject(DOCUMENT);

  protected readonly desktop = this.bridge !== null;
  protected readonly status = signal<DesktopStatus | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);

  // Supabase form drafts. The anon key and JWT secret are cleared after every
  // save, so a saved secret is never echoed back into the page.
  protected readonly projectUrl = signal('');
  protected readonly anonKey = signal('');
  protected readonly jwtSecret = signal('');
  protected readonly savingSupabase = signal(false);
  protected readonly supabaseError = signal<string | null>(null);

  protected readonly lanBusy = signal(false);
  protected readonly lanError = signal<string | null>(null);
  protected readonly pairingLoading = signal(false);
  protected readonly lanUrl = signal<string | null>(null);
  protected readonly qrDataUrl = signal<string | null>(null);

  protected readonly restarting = signal(false);
  protected readonly serverError = signal<string | null>(null);

  private qrRun = 0;

  protected readonly canSaveSupabase = computed(
    () =>
      !!this.projectUrl().trim() &&
      !!this.anonKey().trim() &&
      !this.savingSupabase(),
  );

  protected readonly serverLabel = computed(() => {
    switch (this.status()?.server) {
      case 'ready':
        return 'Running';
      case 'starting':
        return 'Starting…';
      case 'error':
        return 'Error';
      default:
        return 'Unknown';
    }
  });

  constructor() {
    void this.refresh();
  }

  /** Re-read the main process status and, when enabled, the LAN pairing. */
  protected async refresh(): Promise<void> {
    if (!this.bridge) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const status = await this.bridge.getStatus();
      this.status.set(status);
      await this.refreshPairing(status);
    } catch (err) {
      this.loadError.set(
        this.message(err, 'Could not read the desktop app status.'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  protected onProjectUrl(event: Event): void {
    this.projectUrl.set(inputValue(event));
  }

  protected onAnonKey(event: Event): void {
    this.anonKey.set(inputValue(event));
  }

  protected onJwtSecret(event: Event): void {
    this.jwtSecret.set(inputValue(event));
  }

  /** Save the project URL + anon key (and optional legacy JWT secret), then test. */
  protected async saveSupabase(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.bridge || this.savingSupabase()) return;
    const url = this.projectUrl().trim();
    const anonKey = this.anonKey().trim();
    if (!url) {
      this.supabaseError.set('Enter your Supabase project URL.');
      return;
    }
    if (!anonKey) {
      this.supabaseError.set('Enter the project anon key.');
      return;
    }
    const config: SupabaseConfigInput = { url, anonKey };
    const jwtSecret = this.jwtSecret().trim();
    if (jwtSecret) config.jwtSecret = jwtSecret;

    this.savingSupabase.set(true);
    this.supabaseError.set(null);
    try {
      const result = await this.bridge.saveSupabaseConfig(config);
      if (!result.ok) {
        // The main process rejects service-role / sb_secret_ keys here.
        this.supabaseError.set(result.error);
        return;
      }
      this.status.set(result.status);
      this.anonKey.set('');
      this.jwtSecret.set('');
      await this.refreshPairing(result.status);
      this.toast.show('Supabase saved and tested');
    } catch (err) {
      this.supabaseError.set(
        this.message(err, 'Could not save the Supabase settings.'),
      );
    } finally {
      this.savingSupabase.set(false);
    }
  }

  protected async setLan(enabled: boolean): Promise<void> {
    if (!this.bridge || this.lanBusy()) return;
    this.lanBusy.set(true);
    this.lanError.set(null);
    try {
      const result = await this.bridge.setLanEnabled(enabled);
      if (!result.ok) {
        this.lanError.set(result.error);
        return;
      }
      this.status.set(result.status);
      await this.refreshPairing(result.status);
      this.toast.show(
        enabled ? 'Phones on this network can connect' : 'LAN access turned off',
      );
    } catch (err) {
      this.lanError.set(this.message(err, 'Could not change LAN access.'));
    } finally {
      this.lanBusy.set(false);
    }
  }

  protected async restartServer(): Promise<void> {
    if (!this.bridge || this.restarting()) return;
    this.restarting.set(true);
    this.serverError.set(null);
    try {
      const result = await this.bridge.restartServer();
      if (!result.ok) {
        this.serverError.set(result.error);
        return;
      }
      this.status.set(result.status);
      await this.refreshPairing(result.status);
      this.toast.show('Server restarted');
    } catch (err) {
      this.serverError.set(this.message(err, 'Could not restart the server.'));
    } finally {
      this.restarting.set(false);
    }
  }

  protected async openDataFolder(): Promise<void> {
    try {
      await this.bridge?.openDataFolder();
    } catch {
      this.toast.show('Could not open the data folder.');
    }
  }

  protected async openGuide(): Promise<void> {
    try {
      await this.bridge?.openGuide();
    } catch {
      this.toast.show('Could not open the setup guide.');
    }
  }

  protected async copyLanUrl(): Promise<void> {
    const url = this.lanUrl();
    if (!url) return;
    if (await this.writeClipboard(url)) this.toast.show('LAN address copied');
    else this.toast.show('Could not copy. Select the address and copy it.');
  }

  /** Read the LAN address from the main process and turn it into a QR image. */
  private async refreshPairing(status = this.status()): Promise<void> {
    if (!this.bridge || !status?.lanEnabled) {
      this.lanUrl.set(null);
      this.qrDataUrl.set(null);
      this.pairingLoading.set(false);
      return;
    }
    this.lanError.set(null);
    this.pairingLoading.set(true);
    try {
      const pairing = await this.bridge.getPairing();
      const url = pairing.lanUrl ?? status.lanUrl;
      if (!url) {
        this.lanUrl.set(null);
        this.qrDataUrl.set(null);
        return;
      }
      this.lanUrl.set(url);
      await this.renderQr(url);
    } catch (err) {
      this.lanUrl.set(null);
      this.qrDataUrl.set(null);
      this.lanError.set(this.message(err, 'Could not read the LAN address.'));
    } finally {
      this.pairingLoading.set(false);
    }
  }

  /** Encode only the LAN URL (never a token) as an ivory-on-ink PNG data URL. */
  private async renderQr(url: string): Promise<void> {
    const run = ++this.qrRun;
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 240,
        color: { dark: '#16181c', light: '#efe5cf' },
      });
      if (run === this.qrRun) this.qrDataUrl.set(dataUrl);
    } catch {
      if (run !== this.qrRun) return;
      this.qrDataUrl.set(null);
      this.lanError.set(
        'Could not draw the QR code. Copy the address instead.',
      );
    }
  }

  private async writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API is unavailable on plain-HTTP LAN pages; fall back below.
    }
    const area = this.document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    this.document.body.appendChild(area);
    area.select();
    try {
      return this.document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }

  private message(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.trim()
      ? error.message
      : fallback;
  }
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : '';
}
