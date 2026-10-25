import { Injectable, computed, inject, signal } from '@angular/core';
import { SETTINGS_KEYS, StoragePort } from '@open-record/storage';
import { MetadataPort } from './ports';

/**
 * App settings. Hydrates from storage on construction; setters persist
 * optimistically and roll back if the write fails.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly storage = inject(StoragePort);
  private readonly metadata = inject(MetadataPort, { optional: true });

  private readonly _onlineMetadata = signal(true);
  private readonly _hydrated = signal(false);

  /** User allows MusicBrainz / Cover Art Archive lookups. Default true. */
  readonly onlineMetadata = this._onlineMetadata.asReadonly();
  /** True once the stored settings have been read. */
  readonly hydrated = this._hydrated.asReadonly();
  /** Lookups can run on this platform (false on web or without a MetadataPort). */
  readonly onlineSupported = this.metadata?.available ?? false;
  /** Online lookups are both allowed and supported. */
  readonly onlineEnabled = computed(() => this._hydrated() && this._onlineMetadata() && this.onlineSupported);

  private readonly loaded: Promise<void>;

  constructor() {
    this.loaded = this.hydrate();
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  async setOnlineMetadata(on: boolean): Promise<void> {
    await this.loaded;
    const before = this._onlineMetadata();
    if (before === on) return;
    this._onlineMetadata.set(on);
    try {
      await this.storage.settings.set(SETTINGS_KEYS.onlineMetadata, on);
    } catch (err) {
      this._onlineMetadata.set(before);
      throw err;
    }
  }

  /** Re-read from storage (e.g. after a full reset). */
  async reload(): Promise<void> {
    await this.hydrate();
  }

  private async hydrate(): Promise<void> {
    try {
      const stored = await this.storage.settings.get<boolean>(SETTINGS_KEYS.onlineMetadata);
      this._onlineMetadata.set(stored ?? true);
    } catch {
      this._onlineMetadata.set(true);
    } finally {
      this._hydrated.set(true);
    }
  }
}
