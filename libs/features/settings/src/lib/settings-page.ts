import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  AUDIO_QUALITIES,
  isAudioQuality,
  isDownloadLocation,
  parsePairingLink,
  type AudioQuality,
  type DownloadLocation,
} from '@open-record/models';
import {
  AuthStore,
  AutoDownloadStore,
  FailedDownloadsStore,
  DeviceStoragePort,
  LibraryStore,
  PairingScannerPort,
  PlaylistsStore,
  SessionStore,
  SettingsStore,
  type StorageUsage,
} from '@open-record/state';
import {
  OrButton,
  OrDialog,
  OrDownloadProgress,
  OrIcon,
  OrSectionHead,
  OrSpinner,
  OrSwitch,
  OrToast,
  OrViewport,
} from '@open-record/ui';
import { MUSIC_DISCLAIMER } from './credits';
import { formatBytes } from './format-bytes';

const LOCATION_LABELS: Record<DownloadLocation, string> = {
  data: 'App storage (default)',
  external: 'External app storage',
};

const QUALITY_LABELS: Record<AudioQuality, string> = {
  highest: 'Highest (best available)',
  high: 'High (about 160 kbps)',
  medium: 'Medium (about 128 kbps)',
  low: 'Low (about 64 kbps, data saver)',
};

/**
 * Settings screen: a link to Account (phone), a link to Import (phone; desktop
 * has it in the sidebar), the stream server (URL, connection test), audio
 * quality, device storage (native: downloads, free space, download location),
 * auto-download network rule, on-device storage with clear-all, and the music
 * disclaimer. Import itself lives on the Import page.
 */
@Component({
  selector: 'or-settings-page',
  imports: [
    OrDownloadProgress,
    OrButton,
    OrIcon,
    OrSectionHead,
    OrSpinner,
    OrSwitch,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (auth.available && !viewport.isDesktop()) {
      <a class="account-row" routerLink="/account">
        <or-icon name="users" [size]="20" />
        <span class="account-txt">
          Account
          <span class="account-meta">{{
            auth.user()?.email || 'Sign in or create an account'
          }}</span>
        </span>
      </a>
    }

    @if (!viewport.isDesktop()) {
      <a class="fix-row" routerLink="/import">
        <or-icon name="upload" [size]="20" />
        <span class="fix-txt">Import playlists &amp; files</span>
      </a>
    }

    <or-section-head heading="Stream server" />
    <p class="lede">
      Connect your self-hosted Open Record server to search sites and stream
      records. Saved songs live on this device; unsaved songs are streamed.
      Scan the QR code the server shows, or enter its address. Sign in to your
      account to use it.
    </p>
    @if (settings.serverAvailable) {
      <form class="server" (submit)="saveServer($event)">
        @if (canScan()) {
          <or-button
            block
            [disabled]="scanning() || savingServer() || testing()"
            (click)="scanQr()"
            >Scan QR code</or-button
          >
        }
        <label class="field-label" for="or-server-url">Server URL</label>
        <input
          id="or-server-url"
          class="input"
          type="url"
          inputmode="url"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="https://music.example.com"
          aria-describedby="or-server-status"
          [attr.aria-invalid]="serverError() ? 'true' : null"
          [value]="serverUrl()"
          (input)="onServerInput($event)"
        />
        <div class="server-actions">
          <or-button
            type="submit"
            [disabled]="savingServer() || !serverDirty()"
          >
            Save
          </or-button>
          <or-button
            [disabled]="savingServer() || testing() || !serverUrl().trim()"
            (click)="testServer()"
          >
            Test connection
          </or-button>
        </div>
        <p id="or-server-status" class="status" role="status">
          @if (serverError(); as e) {
            <span class="status-bad"
              ><or-icon name="alert" [size]="14" />{{ e }}</span
            >
          } @else if (scanning()) {
            <span class="status-muted">Scanning…</span>
          } @else if (testing()) {
            <span class="status-muted"
              ><or-spinner [size]="14" />Testing connection…</span
            >
          } @else if (connection().status === 'ok') {
            <span class="status-ok"
              ><or-icon name="check" [size]="14" />Connected. Streaming is
              ready.</span
            >
          } @else if (connectionError(); as e) {
            <span class="status-bad"
              ><or-icon name="alert" [size]="14" />{{ e }}</span
            >
          } @else if (settings.downloadServerConfigured()) {
            <span class="status-muted"
              >Saved. Test the connection to check it.</span
            >
          } @else {
            <span class="status-muted">No server set up.</span>
          }
        </p>
      </form>
      <p class="note">
        You are responsible for what you stream and save. Only use music you
        have the rights to.
      </p>
      <button type="button" class="text-link" (click)="showDisclaimer()">
        Read the music disclaimer
      </button>
    } @else {
      <p class="note">Streaming from a server is not available in this build.</p>
    }

    <or-section-head heading="Audio quality" />
    <p class="lede">
      Higher quality sounds better but uses more data and storage. If a record
      is not available at the chosen level, the closest one is used.
    </p>
    <div class="quality">
      <label class="field-label" for="or-stream-quality">Streaming quality</label>
      <select
        id="or-stream-quality"
        class="input select"
        [value]="settings.audioQuality().stream"
        (change)="setQuality($event, 'stream')"
      >
        @for (q of qualities; track q.value) {
          <option [value]="q.value" [selected]="q.value === settings.audioQuality().stream">
            {{ q.label }}
          </option>
        }
      </select>
      <or-switch
        label="Use streaming quality for downloads"
        description="Saved records use the same level as streaming."
        [checked]="settings.audioQuality().sameForDownloads"
        (checkedChange)="setSameQuality($event)"
      />
      @if (!settings.audioQuality().sameForDownloads) {
        <label class="field-label" for="or-download-quality">Download quality</label>
        <select
          id="or-download-quality"
          class="input select"
          [value]="settings.audioQuality().download"
          (change)="setQuality($event, 'download')"
        >
          @for (q of qualities; track q.value) {
            <option [value]="q.value" [selected]="q.value === settings.audioQuality().download">
              {{ q.label }}
            </option>
          }
        </select>
      }
    </div>

    <or-section-head heading="Playback" />
    <div class="playback">
      <label class="field-label" for="or-device-name">This device</label>
      <input
        id="or-device-name"
        class="input"
        type="text"
        autocomplete="off"
        autocapitalize="words"
        spellcheck="false"
        [value]="deviceNameDraft()"
        (input)="onDeviceNameInput($event)"
        (blur)="saveDeviceName()"
      />
      <or-switch
        label="Sync playback between devices"
        [description]="syncDescription()"
        [checked]="settings.sessionEnabled()"
        [disabled]="!playbackAvailable()"
        (checkedChange)="setSessionEnabled($event)"
      />
      <or-switch
        label="Cast to Google Home"
        [description]="castDescription()"
        [checked]="settings.castEnabled()"
        [disabled]="!playbackAvailable()"
        (checkedChange)="setCastEnabled($event)"
      />
      @if (settings.castEnabled()) {
        <or-button
          class="clear-cache"
          [disabled]="clearingCast()"
          (click)="clearCastCache()"
        >
          {{ clearingCast() ? 'Clearing cast cache…' : 'Clear cast cache' }}
        </or-button>
        @if (castUsage(); as usage) {
          <dl class="usage cast" aria-live="polite">
            <div class="usage-row">
              <dt>Cast cache</dt>
              <dd>
                {{ formatBytes(usage.bytes) }} of {{ formatBytes(usage.cap) }}
              </dd>
            </div>
          </dl>
        }
      }
    </div>

    @if (device?.native) {
      <or-section-head heading="Device storage" />
      <dl class="usage device" aria-live="polite">
        <div class="usage-row">
          <dt>Auto-download</dt>
          <dd>{{ autoDownloadSummary() }}</dd>
        </div>
        <div class="usage-row">
          <dt>Downloaded songs</dt>
          <dd>{{ library.downloaded().count }}</dd>
        </div>
        <div class="usage-row">
          <dt>Space used</dt>
          <dd>{{ formatBytes(library.downloaded().bytes) }}</dd>
        </div>
        @if (freeSpace(); as space) {
          <div class="usage-row">
            <dt>Free on device</dt>
            <dd>
              {{ formatBytes(space.freeBytes) }}
              @if (space.totalBytes) {
                of {{ formatBytes(space.totalBytes) }}
              }
            </dd>
          </div>
        }
      </dl>
      @if (device.locations.length > 1) {
        <div class="quality">
          <label class="field-label" for="or-download-location">Download location</label>
          <select
            id="or-download-location"
            class="input select"
            aria-describedby="or-download-location-note"
            [value]="settings.downloadLocation()"
            (change)="setLocation($event)"
          >
            @for (loc of locations(); track loc.value) {
              <option [value]="loc.value" [selected]="loc.value === settings.downloadLocation()">
                {{ loc.label }}
              </option>
            }
          </select>
        </div>
        <p class="note" id="or-download-location-note">
          Only new downloads go here; saved songs stay where they are. Both are
          removed if you uninstall the app.
        </p>
      }
    }

    <or-section-head heading="Auto-download" />
    <p class="lede">
      Turn on auto-download in your Library or on a playlist to keep those
      records saved on this device. Auto-downloads run on Wi-Fi only unless you
      allow mobile data.
    </p>
    <or-switch
      label="Allow auto-download on mobile data"
      description="Saving records over mobile data can use a lot of data."
      [checked]="settings.autoDownloadOnMobileData()"
      (checkedChange)="setMobileData($event)"
    />
    @if (autoDownload.countsFor(autoDownload.wanted()); as p) {
      @if (p.downloading) {
        <or-download-progress
          label="Auto-download progress"
          [saved]="p.saved"
          [total]="p.total"
          [fraction]="autoDownloadFraction"
        />
      }
    }
    <p class="note auto-status" role="status">
      @if (autoDownload.pauseReason(); as paused) {
            {{ paused }}
          } @else if (failedDownloads.count(); as n) {
            <a class="failed-link" routerLink="/downloads/failed">{{ n }} couldn’t be downloaded</a>
          }
    </p>
    @if (autoDownload.canRetry()) {
      <or-button size="sm" class="retry" (click)="autoDownload.retryFailed()">
        Retry failed downloads
      </or-button>
    }
    <a class="fix-row" routerLink="/downloads/failed">
      <or-icon name="link" [size]="20" />
      <span class="fix-txt">Fix failed downloads</span>
    </a>

    <or-section-head heading="Storage" />
    <dl class="usage" aria-live="polite">
      @for (row of usageRows(); track row.label) {
        <div class="usage-row">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </div>
      }
    </dl>
    <div class="stack">
      <or-button
        block
        variant="danger"
        [disabled]="busy()"
        (click)="clearAll()"
      >
        Clear all data
      </or-button>
    </div>
    <p class="note">
      Clear all data also removes saved records, playlists and settings. The
      bundled catalogue stays.
    </p>

    <or-section-head heading="About" />
    <p #disclaimerEl id="music-disclaimer" class="disclaimer" tabindex="-1">
      <span class="eyebrow">Music disclaimer</span>
      {{ disclaimer }}
    </p>
  `,
  styles: `
    :host {
      display: block;
    }
    or-section-head:first-child {
      margin-top: var(--spacing-xs);
    }
    .account-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      min-block-size: 64px;
      margin-bottom: var(--spacing-sm);
      padding: 0 var(--spacing-md);
      color: var(--color-text);
      text-decoration: none;
      background: var(--color-surface);
      border-radius: var(--rounded-md);
    }
    .account-row:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .account-txt {
      display: grid;
      min-inline-size: 0;
      font-family: var(--font-display);
      font-size: 18px;
    }
    .account-meta {
      overflow: hidden;
      font: 13px var(--font-body, inherit);
      color: var(--color-muted);
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .lede,
    .note {
      margin: var(--spacing-xs) 0 var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
    }
    .note {
      margin: var(--spacing-sm) 0 0;
      font-size: 12px;
    }
    .auto-status {
      min-block-size: 18px;
    }

    .failed-link, .fix-row { display: inline-flex; align-items: center; gap: var(--spacing-sm);
      min-block-size: var(--spacing-touch); color: var(--color-text); border-radius: var(--rounded-md); }
    .failed-link { text-decoration: underline; }
    .fix-row { display: flex; text-decoration: none; }
    .retry {
      margin-block-start: var(--spacing-sm);
    }
    .usage {
      display: grid;
      margin: var(--spacing-sm) 0 var(--spacing-md);
    }
    .usage-row {
      display: flex;
      justify-content: space-between;
      gap: var(--spacing-md);
      padding: 10px 0;
      font-size: 14px;
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .usage-row:first-child {
      border-top: 0;
    }
    .usage-row:last-child dt {
      font-weight: 600;
    }
    .device .usage-row:last-child dt {
      font-weight: inherit;
    }
    dt {
      color: var(--color-text);
    }
    dd {
      margin: 0;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
      text-align: end;
    }
    .stack {
      display: grid;
      gap: var(--spacing-sm);
    }
    .disclaimer {
      display: grid;
      gap: var(--spacing-xs);
      margin: var(--spacing-lg) 0 0;
      padding: var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
      border: 1px dashed
        color-mix(in srgb, var(--color-border) 75%, transparent);
      border-radius: var(--rounded-md);
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .disclaimer:focus-visible,
    .text-link:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }

    /* Download server form. */
    .server {
      display: grid;
      gap: var(--spacing-xs);
    }
    .field-label {
      margin-top: var(--spacing-xs);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .input {
      min-block-size: var(--spacing-touch);
      padding: 0 var(--spacing-sm);
      font: inherit;
      color: var(--color-text);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      outline: none;
      transition: border-color var(--duration-fast) var(--ease-standard);
    }
    .input::placeholder {
      color: var(--color-muted);
    }
    .input:focus,
    .input[aria-invalid='true'] {
      border-color: var(--color-primary);
    }
    .quality {
      display: grid;
      gap: var(--spacing-xs);
    }
    .playback {
      display: grid;
      gap: var(--spacing-xs);
    }
    .playback .clear-cache {
      justify-self: start;
      margin-top: var(--spacing-xs);
    }
    .select {
      appearance: none;
      padding-inline-end: 36px;
      background-image: linear-gradient(45deg, transparent 50%, var(--color-muted) 50%),
        linear-gradient(135deg, var(--color-muted) 50%, transparent 50%);
      background-position:
        calc(100% - 18px) 50%,
        calc(100% - 13px) 50%;
      background-size: 5px 5px;
      background-repeat: no-repeat;
      cursor: pointer;
    }
    .select:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .server-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-sm);
    }
    /* Reserved status line so the form does not jump. */
    .status {
      margin: 0;
      min-block-size: 18px;
      font-size: 12px;
      line-height: 1.5;
    }
    .status-bad,
    .status-ok,
    .status-muted {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .status-bad {
      color: var(--color-primary);
    }
    .status-ok {
      color: var(--color-text);
    }
    .status-muted {
      color: var(--color-muted);
    }
    .text-link {
      display: inline-flex;
      align-items: center;
      min-block-size: var(--spacing-touch);
      padding: 0;
      font: inherit;
      font-size: 13px;
      color: var(--color-text);
      text-decoration: underline;
      text-underline-offset: 3px;
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      cursor: pointer;
    }
    @media (prefers-reduced-motion: reduce) {
      .input {
        transition-duration: 1ms;
      }
    }
  `,
})
export class SettingsPage {
  protected readonly library = inject(LibraryStore);
  protected readonly settings = inject(SettingsStore);
  protected readonly session = inject(SessionStore);
  protected readonly auth = inject(AuthStore);
  protected readonly viewport = inject(OrViewport);
  private readonly route = inject(ActivatedRoute);
  private readonly dialog = inject(OrDialog);
  private readonly toast = inject(OrToast);
  private readonly scanner = inject(PairingScannerPort, { optional: true });
  private readonly playlists = inject(PlaylistsStore);
  protected readonly autoDownload = inject(AutoDownloadStore);
  /** Live 0-1 auto-download fraction, read only by the progress bar. */
  protected readonly autoDownloadFraction = computed(
    () => this.autoDownload.progress().fraction,
  );
  protected readonly failedDownloads = inject(FailedDownloadsStore);
  /** Native device storage info; absent or `native: false` on web. */
  protected readonly device = inject(DeviceStoragePort, { optional: true });
  protected readonly formatBytes = formatBytes;

  protected readonly locations = computed(() =>
    (this.device?.locations ?? []).map((value) => ({
      value,
      label: LOCATION_LABELS[value],
    })),
  );
  /** Free/total bytes behind the chosen location; null hides the row. */
  protected readonly freeSpace = signal<{
    freeBytes: number;
    totalBytes?: number;
  } | null>(null);
  private spaceRun = 0;

  protected readonly autoDownloadSummary = computed(() => {
    const parts: string[] = [];
    if (this.settings.autoDownloadLibrary()) parts.push('Library');
    const n = this.playlists.playlists().filter((p) => p.autoDownload).length;
    if (n) parts.push(`${n} playlist${n === 1 ? '' : 's'}`);
    return parts.length ? `On for ${parts.join(' and ')}` : 'Off';
  });

  protected readonly disclaimer = MUSIC_DISCLAIMER;

  protected readonly qualities: readonly { value: AudioQuality; label: string }[] =
    AUDIO_QUALITIES.map((value) => ({ value, label: QUALITY_LABELS[value] }));

  protected readonly imported = this.library.importedTracks;
  protected readonly busy = signal(false);

  // Device name draft; reset after saving so the store's trimming and length
  // limit show in the field.
  protected readonly deviceNameDraft = linkedSignal(() =>
    this.settings.deviceName(),
  );
  protected readonly clearingCast = signal(false);
  /** Server-side cast cache usage; null hides the line (no adapter/offline). */
  protected readonly castUsage = signal<{
    bytes: number;
    count: number;
    cap: number;
  } | null>(null);
  private castUsageRun = 0;

  /** A stream server is paired (saved and applied, or at least a URL saved). */
  protected readonly serverPaired = computed(
    () =>
      this.settings.downloadServerConfigured() ||
      !!this.settings.downloadServerUrl(),
  );

  /** Session sync and casting need a paired server and a signed-in account. */
  protected readonly playbackAvailable = computed(
    () => this.serverPaired() && this.auth.signedIn(),
  );

  protected readonly playbackDisabledReason = computed(() => {
    const server = this.serverPaired();
    if (!server && !this.auth.signedIn())
      return 'Pair a stream server and sign in to sync or cast.';
    if (!server) return 'Pair a stream server to sync or cast.';
    return 'Sign in to your account to sync or cast.';
  });

  /** Why the playback switches are off (also read by screen readers). */
  protected readonly syncDescription = computed(() =>
    this.playbackAvailable()
      ? 'Needs a signed-in account and the stream server.'
      : this.playbackDisabledReason(),
  );

  protected readonly castDescription = computed(() =>
    this.playbackAvailable()
      ? 'Uses the PC running the server to play on the speaker.'
      : this.playbackDisabledReason(),
  );

  // Download server form drafts; reset when the stored values change.
  protected readonly serverUrl = linkedSignal(() =>
    this.settings.downloadServerUrl(),
  );
  protected readonly serverDirty = computed(
    () => this.serverUrl().trim() !== this.settings.downloadServerUrl(),
  );
  protected readonly savingServer = signal(false);
  /** QR scanning is offered only where the app provides a pairing scanner. */
  protected readonly canScan = signal(false);
  protected readonly scanning = signal(false);
  protected readonly serverError = signal<string | null>(null);
  protected readonly connection = this.settings.connection;
  protected readonly testing = computed(
    () => this.connection().status === 'testing',
  );
  protected readonly connectionError = computed(() => {
    const c = this.connection();
    return c.status === 'error' ? c.message : null;
  });
  private readonly disclaimerEl =
    viewChild.required<ElementRef<HTMLElement>>('disclaimerEl');

  private readonly usage = signal<StorageUsage | null>(null);
  private usageRun = 0;

  protected readonly usageRows = computed(() => {
    const u = this.usage();
    const fmt = (n: number | null | undefined) =>
      u ? (n == null ? 'Unknown' : formatBytes(n)) : '…';
    return [
      { label: 'Imported audio', value: fmt(u?.importedAudioBytes) },
      { label: 'Cover art', value: fmt(u?.artBytes) },
      { label: 'Metadata', value: fmt(u?.metadataBytes) },
      { label: 'Bundled catalogue', value: fmt(u?.catalogBytes) },
      { label: 'You can free', value: fmt(u?.removableBytes) },
    ];
  });

  constructor() {
    // Search links here with #music-disclaimer.
    afterNextRender(() => {
      if (this.route.snapshot.fragment === 'music-disclaimer')
        this.showDisclaimer();
    });
    if (this.scanner)
      void this.scanner.available().then((ok) => this.canScan.set(ok));
    // Native: re-read free space when the location or downloads change.
    if (this.device?.native)
      effect(() => {
        const location = this.settings.downloadLocation();
        this.library.downloaded();
        untracked(() => void this.refreshSpace(location));
      });
    // Re-measure storage when imports change.
    effect(() => {
      this.imported();
      untracked(() => void this.refreshUsage());
    });
    // Cast cache usage is server-side; null on native/offline hides the line.
    void this.refreshCastUsage();
  }

  protected onServerInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    // A pasted pairing link fills in the address and connects at once.
    if (parsePairingLink(value)) {
      void this.pairWith(value);
      return;
    }
    this.serverUrl.set(value);
    this.serverError.set(null);
  }

  protected async saveServer(event?: Event): Promise<boolean> {
    event?.preventDefault();
    if (!this.serverDirty()) return true;
    this.savingServer.set(true);
    this.serverError.set(null);
    try {
      await this.settings.setDownloadServer({ url: this.serverUrl() });
      if (event)
        this.toast.show(
          this.serverUrl().trim()
            ? 'Stream server saved'
            : 'Stream server removed',
        );
      return true;
    } catch (err) {
      this.serverError.set(
        err instanceof Error && err.message.startsWith('Enter')
          ? err.message
          : 'Could not save the server. Try again.',
      );
      return false;
    } finally {
      this.savingServer.set(false);
    }
  }

  /** Pair from a pairing link, then show its outcome on the status line. */
  private async pairWith(text: string): Promise<void> {
    if (this.savingServer()) return;
    this.savingServer.set(true);
    this.serverError.set(null);
    try {
      const result = await this.settings.pairFromLink(text);
      // Show the saved address (the pasted link text is not a URL).
      this.serverUrl.set(this.settings.downloadServerUrl());
      if (result.ok) this.toast.show('Paired with your server');
      else this.serverError.set(result.message);
    } finally {
      this.savingServer.set(false);
    }
  }

  protected async scanQr(): Promise<void> {
    if (!this.scanner || this.scanning() || this.savingServer()) return;
    this.scanning.set(true);
    this.serverError.set(null);
    let text: string | null = null;
    try {
      text = await this.scanner.scan();
    } catch (err) {
      this.serverError.set(
        err instanceof Error ? err.message : 'Scanning failed. Try again.',
      );
    } finally {
      this.scanning.set(false);
    }
    if (text !== null) await this.pairWith(text);
  }

  protected setQuality(event: Event, which: 'stream' | 'download'): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!isAudioQuality(value)) return;
    void this.saveSetting(() => this.settings.setAudioQuality({ [which]: value }));
  }

  protected setSameQuality(on: boolean): void {
    void this.saveSetting(() =>
      this.settings.setAudioQuality({ sameForDownloads: on }),
    );
  }

  protected setMobileData(on: boolean): void {
    void this.saveSetting(() => this.settings.setAutoDownload({ mobileData: on }));
  }

  protected setSessionEnabled(on: boolean): void {
    void this.saveSetting(() => this.settings.setSessionEnabled(on));
  }

  protected setCastEnabled(on: boolean): void {
    void this.saveSetting(() => this.settings.setCastEnabled(on));
  }

  protected onDeviceNameInput(event: Event): void {
    this.deviceNameDraft.set((event.target as HTMLInputElement).value);
  }

  protected async saveDeviceName(): Promise<void> {
    try {
      await this.settings.setDeviceName(this.deviceNameDraft());
    } catch {
      this.toast.show('Could not save the device name. Try again.');
    } finally {
      this.deviceNameDraft.set(this.settings.deviceName());
    }
  }

  protected async clearCastCache(): Promise<void> {
    if (this.clearingCast()) return;
    this.clearingCast.set(true);
    try {
      const { freedBytes, retainedBytes } = await this.session.clearCastCache();
      const bytes = `${this.formatBytes(freedBytes)} freed, ${this.formatBytes(retainedBytes)} retained`;
      this.toast.show(
        freedBytes || retainedBytes
          ? `Cast cache cleared: ${bytes}`
          : `Cast cache is already empty: ${bytes}`,
      );
    } catch {
      this.toast.show('Could not clear the cast cache. Try again.');
    } finally {
      this.clearingCast.set(false);
      void this.refreshCastUsage();
    }
  }

  private async refreshCastUsage(): Promise<void> {
    const run = ++this.castUsageRun;
    const usage = await this.session.castCacheUsage();
    if (run === this.castUsageRun) this.castUsage.set(usage);
  }

  protected setLocation(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!isDownloadLocation(value)) return;
    void this.saveSetting(() => this.settings.setDownloadLocation(value));
  }

  private async refreshSpace(location: DownloadLocation): Promise<void> {
    const run = ++this.spaceRun;
    const valid = this.device?.locations.includes(location) ? location : 'data';
    const space = (await this.device?.space(valid).catch(() => null)) ?? null;
    if (run === this.spaceRun) this.freeSpace.set(space);
  }

  private async saveSetting(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch {
      this.toast.show('Could not save that setting. Try again.');
    }
  }

  protected async testServer(): Promise<void> {
    if (!(await this.saveServer())) return;
    await this.settings.testConnection();
  }

  protected showDisclaimer(): void {
    const el = this.disclaimerEl().nativeElement;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }

  protected async clearAll(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Clear all data?',
      message:
        'This deletes imported files, saved records, playlists and settings. It cannot be undone.',
      confirmLabel: 'Clear all data',
      danger: true,
    });
    if (!ok) return;
    await this.run(() => this.library.clearAll(), 'All data cleared');
  }

  private async run(action: () => Promise<void>, done: string): Promise<void> {
    this.busy.set(true);
    try {
      await action();
      this.toast.show(done);
    } catch {
      this.toast.show('Something went wrong. Try again.');
    } finally {
      this.busy.set(false);
      void this.refreshUsage();
    }
  }

  private async refreshUsage(): Promise<void> {
    const run = ++this.usageRun;
    try {
      const usage = await this.library.storageUsage();
      if (run === this.usageRun) this.usage.set(usage);
    } catch {
      // Keep the last known figures.
    }
  }

}
