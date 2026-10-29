import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import type { SessionDevice, SessionTarget } from '@open-record/models';
import { SessionStore } from '@open-record/state';
import {
  OrButton,
  OrIcon,
  OrModal,
  OrSlider,
  OrTag,
  type IconName,
} from '@open-record/ui';

const PLATFORM_ICON: Record<SessionDevice['platform'], IconName> = {
  android: 'phone',
  ios: 'phone',
  web: 'desktop',
  cast: 'cast',
};

const PLATFORM_LABEL: Record<SessionDevice['platform'], string> = {
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
  cast: 'Cast',
};

/** Debounce for cast-volume commands while the thumb is moving. */
const VOLUME_DEBOUNCE_MS = 200;

interface PickerRow {
  /** `clientId` for devices and `castId` for cast endpoints. */
  readonly key: string;
  readonly device: SessionDevice;
  readonly current: boolean;
  readonly disabled: boolean;
  readonly cast: boolean;
  readonly castId: string;
  readonly icon: IconName;
  readonly title: string;
  readonly sub: string;
}

/**
 * Root coordinator for the one `<or-device-picker>` mounted by the app shell.
 * Every surface calls `show()`; the picker closes itself when a transfer lands.
 */
@Injectable({ providedIn: 'root' })
export class DevicePickerService {
  readonly open = signal(false);

  show(): void {
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }
}

/**
 * "Play on" picker: one row per `clientId` (two browser tabs stay separate),
 * a roving-tabindex radiogroup, and a cast-only volume slider. Modal focus
 * trap, Escape and focus return come from `OrModal`.
 */
@Component({
  selector: 'or-device-picker',
  imports: [OrButton, OrIcon, OrModal, OrSlider, OrTag],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal
      heading="Play on"
      [open]="picker.open()"
      (dismissed)="picker.close()"
    >
      @if (session.available()) {
        @if (rows().length) {
          <div
            class="rows"
            role="radiogroup"
            aria-label="Play on"
            tabindex="-1"
            (keydown)="onKeydown($event)"
            (focusin)="onFocusIn($event)"
          >
            @for (row of rows(); track row.key; let i = $index) {
              <button
                type="button"
                class="row"
                role="radio"
                [class.current]="row.current"
                [attr.aria-checked]="row.current"
                [attr.tabindex]="
                  row.disabled ? null : i === activeIndex() ? 0 : -1
                "
                [attr.data-row]="i"
                [disabled]="row.disabled"
                (click)="select(row)"
              >
                <span class="mark" aria-hidden="true">
                  @if (row.current) {
                    <or-icon name="check" [size]="12" />
                  }
                </span>
                <or-icon class="kind" [name]="row.icon" [size]="20" />
                <span class="text">
                  <span class="name">{{ row.title }}</span>
                  <span class="sub">{{ row.sub }}</span>
                </span>
                @if (row.cast) {
                  <or-tag>Cast</or-tag>
                }
              </button>
            }
          </div>
        } @else {
          <p class="empty">No other devices are available yet.</p>
        }

        @if (session.session()?.castOwner; as owner) {
          <div class="owner">
            <p class="owner-text">In use by {{ owner.deviceName }}</p>
            <or-button
              size="sm"
              [disabled]="selecting() || !takeOverCastId()"
              (click)="takeOver()"
            >
              Take over
            </or-button>
          </div>
        }

        @if (castTarget()) {
          <div class="volume">
            <div class="volume-head">
              <span class="label">Volume</span>
              <span class="value">{{ volume() }}%</span>
            </div>
            <or-slider
              label="Cast volume"
              [value]="volume()"
              [valueText]="volume() + '%'"
              (valueChange)="onVolumeChange($event)"
              (committed)="commitVolume()"
            />
          </div>
        }
      }

      @if (errorText(); as error) {
        <p class="error" role="alert">{{ error }}</p>
      }

      @if (!session.available()) {
        <div orModalActions>
          <p class="hint">
            Sessions need a signed-in account and a stream server.
          </p>
          <or-button block (click)="openSettings()">Open settings</or-button>
        </div>
      }
    </or-modal>
  `,
  styles: `
    :host {
      display: contents;
    }
    .rows {
      display: grid;
      margin: 0 calc(var(--spacing-xs) * -1);
      padding: 0 var(--spacing-xs);
    }
    .row {
      appearance: none;
      display: grid;
      grid-template-columns: 18px 20px minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--spacing-sm);
      min-block-size: var(--spacing-touch);
      padding: var(--spacing-xs) var(--spacing-sm);
      border: 0;
      border-radius: var(--rounded-md);
      background: transparent;
      color: var(--color-text);
      font: inherit;
      text-align: start;
      cursor: pointer;
      transition: background var(--duration-fast) var(--ease-standard);
    }
    .row + .row {
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
      border-top-left-radius: 0;
      border-top-right-radius: 0;
    }
    @media (hover: hover) {
      .row:hover {
        background: color-mix(in srgb, var(--color-text) 7%, transparent);
      }
    }
    .row:active {
      background: var(--color-surface-raised);
    }
    .row:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .row.current {
      background: color-mix(in srgb, var(--color-ivory) 8%, transparent);
    }
    .row.current .kind {
      color: var(--color-ivory);
    }
    .row:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .mark {
      display: grid;
      place-items: center;
      inline-size: 18px;
      block-size: 18px;
      border: 1.5px solid
        color-mix(in srgb, var(--color-border) 85%, transparent);
      border-radius: var(--rounded-full);
      color: var(--color-ink);
    }
    .row.current .mark {
      background: var(--color-ivory);
      border-color: var(--color-ivory);
    }
    .kind {
      color: var(--color-muted);
    }
    .text {
      display: grid;
      min-inline-size: 0;
    }
    .name {
      overflow: hidden;
      font-family: var(--type-row-title-font-family);
      font-size: var(--type-row-title-font-size);
      font-weight: var(--type-row-title-font-weight);
      line-height: var(--type-row-title-line-height);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sub {
      overflow: hidden;
      color: var(--color-muted);
      font-family: var(--type-meta-font-family);
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
      letter-spacing: var(--type-meta-letter-spacing);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .volume {
      display: grid;
      gap: var(--spacing-xs);
      padding-top: var(--spacing-sm);
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 45%, transparent);
    }
    .volume-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--spacing-sm);
    }
    .label {
      color: var(--color-muted);
      font-family: var(--type-eyebrow-font-family);
      font-size: var(--type-eyebrow-font-size);
      line-height: var(--type-eyebrow-line-height);
      letter-spacing: var(--type-eyebrow-letter-spacing);
      text-transform: uppercase;
    }
    .value {
      color: var(--color-muted);
      font-size: var(--type-meta-font-size);
      font-variant-numeric: tabular-nums;
    }
    .owner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      border: 1px solid
        color-mix(in srgb, var(--color-primary) 42%, transparent);
      border-radius: var(--rounded-md);
      background: color-mix(in srgb, var(--color-primary) 10%, transparent);
    }
    .owner-text {
      margin: 0;
      font-size: var(--type-body-sm-font-size);
    }
    .empty,
    .hint {
      margin: 0;
      color: var(--color-muted);
      font-size: var(--type-body-sm-font-size);
      line-height: var(--type-body-sm-line-height);
    }
    .hint {
      font-size: var(--type-meta-font-size);
    }
    .error {
      margin: 0;
      color: var(--color-primary);
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
    }
    @media (prefers-reduced-motion: reduce) {
      .row {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrDevicePicker {
  protected readonly picker = inject(DevicePickerService);
  protected readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly activeIndex = signal(-1);
  protected readonly volume = signal(0);
  protected readonly selecting = signal(false);

  /** The cast the user last tried to transfer to; needed for "Take over". */
  private readonly attemptedCastId = signal<string | null>(null);
  private volumeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastVolumeKey = '';

  protected readonly castTarget = computed(() => {
    const target = this.session.target();
    return target?.kind === 'cast' ? target : null;
  });

  protected readonly takeOverCastId = computed<string | null>(() => {
    return this.castTarget()?.castId ?? this.attemptedCastId();
  });

  protected readonly errorText = computed(() => {
    const error = this.session.error();
    switch (error) {
      case null:
        return '';
      case 'cast-busy':
        return 'This speaker is already in use.';
      case 'cast-unavailable':
        return 'That speaker is offline.';
      case 'cast-disabled':
        return 'Casting is turned off.';
      case 'cast-upload-unavailable':
        return 'Could not prepare local files for casting.';
      case 'unknown-client':
        return 'That device is no longer available.';
      case 'no-session':
        return 'Nothing is playing yet.';
      case 'unavailable':
        return 'Sessions are unavailable right now.';
      default:
        return error;
    }
  });

  protected readonly rows = computed<readonly PickerRow[]>(() => {
    if (!this.session.available()) return [];
    const devices = this.session.devices();
    const target = this.session.target();
    const state = this.session.session();
    const thisClient = this.session.clientId();
    const targetStale = this.session.targetStale();
    const perDevice = new Map<string, number>();
    for (const device of devices) {
      if (device.platform === 'cast') continue;
      perDevice.set(device.deviceId, (perDevice.get(device.deviceId) ?? 0) + 1);
    }

    return devices.map((device) => {
      const castId = device.castId ?? device.id;
      const current =
        target?.kind === 'device'
          ? target.clientId === device.id
          : target?.kind === 'cast' && target.castId === castId;
      const cast = device.platform === 'cast';
      const stale = current ? targetStale : device.stale === true;
      const status = !device.online
        ? 'Offline'
        : stale
          ? 'Not responding'
          : current
            ? state?.playing
              ? 'playing'
              : 'paused'
            : 'synced';
      const base = cast
        ? (device.model ?? 'Cast')
        : PLATFORM_LABEL[device.platform];
      const thisTab =
        !cast &&
        device.id === thisClient &&
        (perDevice.get(device.deviceId) ?? 0) > 1;

      return {
        key: device.id,
        device,
        current,
        disabled: cast && !device.online,
        cast,
        castId,
        icon: PLATFORM_ICON[device.platform],
        title: thisTab ? `${device.name} · this tab` : device.name,
        sub: `${base} · ${status}`,
      };
    });
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearVolumeTimer());

    // Keep one roving tab stop: the current target, else the first tappable row.
    effect(() => {
      const isOpen = this.picker.open();
      const rows = this.rows();
      if (!isOpen) return;
      untracked(() => {
        const row = rows[this.activeIndex()];
        if (row && !row.disabled) return;
        this.activeIndex.set(this.defaultIndex(rows));
      });
    });

    // Follow the server's cast volume, but never overwrite a thumb mid-drag:
    // the key only changes when the volume (or the cast target) changes.
    effect(() => {
      const state = this.session.session();
      const target = state?.target;
      if (!state || target?.kind !== 'cast') return;
      const percent = Math.round((state.castVolume ?? 0) * 100);
      const key = `${target.castId}|${percent}`;
      if (key === this.lastVolumeKey) return;
      this.lastVolumeKey = key;
      this.volume.set(percent);
    });
  }

  protected async select(row: PickerRow): Promise<void> {
    if (row.disabled || this.selecting()) return;
    this.selecting.set(true);
    if (row.cast) this.attemptedCastId.set(row.castId);
    const target: SessionTarget = row.cast
      ? { kind: 'cast', castId: row.castId }
      : {
          kind: 'device',
          clientId: row.device.id,
          deviceId: row.device.deviceId,
        };
    try {
      if (await this.session.transferTo(target)) {
        this.session.error.set(null);
        this.picker.close();
      }
    } finally {
      this.selecting.set(false);
    }
  }

  protected async takeOver(): Promise<void> {
    const castId = this.takeOverCastId();
    if (!castId || this.selecting()) return;
    this.selecting.set(true);
    try {
      if (await this.session.takeOver(castId)) {
        this.session.error.set(null);
        this.picker.close();
      }
    } finally {
      this.selecting.set(false);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const rows = this.rows();
    const enabled = rows.flatMap((row, index) =>
      row.disabled ? [] : [index],
    );
    if (!enabled.length) return;
    const active = enabled.indexOf(this.activeIndex());
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = enabled[(active + 1 + enabled.length) % enabled.length] ?? 0;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = enabled[active <= 0 ? enabled.length - 1 : active - 1] ?? 0;
        break;
      case 'Home':
        next = enabled[0] ?? 0;
        break;
      case 'End':
        next = enabled[enabled.length - 1] ?? 0;
        break;
      default:
        // Enter/Space activate the focused row button natively.
        return;
    }
    event.preventDefault();
    this.activeIndex.set(next);
    this.host.nativeElement
      .querySelector<HTMLElement>(`[data-row="${next}"]`)
      ?.focus();
  }

  protected onFocusIn(event: FocusEvent): void {
    const target = event.target;
    const row =
      target instanceof Element
        ? target.closest<HTMLElement>('[data-row]')
        : null;
    if (!row) return;
    const index = Number(row.dataset['row']);
    if (Number.isInteger(index)) this.activeIndex.set(index);
  }

  protected onVolumeChange(value: number): void {
    this.volume.set(value);
    this.clearVolumeTimer();
    this.volumeTimer = setTimeout(() => {
      this.volumeTimer = null;
      void this.pushVolume(this.volume());
    }, VOLUME_DEBOUNCE_MS);
  }

  protected commitVolume(): void {
    this.clearVolumeTimer();
    void this.pushVolume(this.volume());
  }

  protected openSettings(): void {
    this.picker.close();
    void this.router.navigateByUrl('/settings');
  }

  private async pushVolume(percent: number): Promise<void> {
    if (this.castTarget()?.kind !== 'cast') return;
    const result = await this.session.command({
      type: 'setCastVolume',
      volume: percent / 100,
    });
    if (!result.ok) {
      this.session.error.set(
        result.error ?? 'Could not set the cast volume.',
      );
    }
  }

  private defaultIndex(rows: readonly PickerRow[]): number {
    const current = rows.findIndex((row) => row.current && !row.disabled);
    return current >= 0 ? current : rows.findIndex((row) => !row.disabled);
  }

  private clearVolumeTimer(): void {
    if (this.volumeTimer === null) return;
    clearTimeout(this.volumeTimer);
    this.volumeTimer = null;
  }
}
