import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
// Eager shell trigger for the one picker mounted by the shell (like App).
// eslint-disable-next-line @nx/enforce-module-boundaries
import { DevicePickerService } from '@open-record/features/now-playing';
import { LibraryStore, PlayerStore, SessionStore } from '@open-record/state';
import {
  OrIcon,
  OrIconButton,
  OrProgressLine,
  OrSleeve,
  OrSpinner,
  type IconName,
} from '@open-record/ui';

/**
 * Mini player strip above the tab bar: 2px progress line, 44px ivory-framed
 * thumbnail, title/artist (both open Now Playing), the device picker, play/pause
 * and next.
 * The shell only renders it while a track is loaded.
 */
@Component({
  selector: 'or-mini-player',
  imports: [OrIcon, OrIconButton, OrProgressLine, OrSleeve, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (player.current(); as track) {
      <or-progress-line class="bar" [value]="player.progress()" />
      <button
        class="art"
        type="button"
        aria-label="Open now playing"
        (click)="open.emit()"
      >
        <or-sleeve size="mini" [src]="art()" [lazy]="false" />
        @if (player.isLoading()) {
          <span class="overlay" aria-hidden="true"><or-spinner /></span>
        } @else if (player.error()) {
          <span class="overlay err" aria-hidden="true">
            <or-icon name="alert" [size]="18" />
          </span>
        }
      </button>
      <button
        class="info"
        type="button"
        aria-label="Open now playing"
        (click)="open.emit()"
      >
        <span class="title">{{ track.title }}</span>
        <span class="artist">{{ track.artist }}</span>
      </button>
      @if (session.available()) {
        <button
          class="device"
          type="button"
          aria-haspopup="dialog"
          [attr.aria-label]="'Playback device: ' + targetName()"
          (click)="picker.show()"
        >
          <or-icon [name]="deviceIcon()" [size]="20" />
        </button>
      }
      <or-icon-button
        [label]="player.isPlaying() ? 'Pause' : 'Play'"
        [icon]="player.isPlaying() ? 'pause' : 'play'"
        (click)="player.togglePlay()"
      />
      <or-icon-button
        label="Next record"
        icon="next"
        [disabled]="!player.hasNext()"
        (click)="player.next()"
      />
    }
  `,
  styles: `
    :host {
      position: relative;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto auto;
      align-items: center;
      gap: 6px;
      padding: 6px 6px 6px 8px;
      background: var(--color-surface);
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 60%, transparent);
    }
    .bar {
      position: absolute;
      left: 0;
      right: 0;
      top: -1px;
    }
    button.art,
    button.info {
      appearance: none;
      border: 0;
      padding: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      border-radius: var(--rounded-sleeve);
    }
    .art {
      position: relative;
      display: block;
      inline-size: 44px;
      block-size: 44px;
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      border-radius: 2px;
      background: color-mix(in srgb, var(--color-vinyl) 72%, transparent);
      color: var(--color-text);
    }
    .overlay.err {
      color: var(--color-primary);
    }
    .info {
      display: grid;
      min-width: 0;
      min-height: var(--spacing-touch);
      align-content: center;
      padding: 0 var(--spacing-xs);
      text-align: left;
      border-radius: var(--rounded-md);
    }
    .title,
    .artist {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.25;
    }
    .artist {
      font-size: var(--type-meta-font-size);
      color: var(--color-muted);
    }
    /* Same 44px plain icon-button target as OrIconButton. */
    .device {
      appearance: none;
      display: grid;
      place-items: center;
      inline-size: var(--spacing-touch);
      block-size: var(--spacing-touch);
      padding: 0;
      border: 0;
      border-radius: var(--rounded-md);
      background: transparent;
      color: var(--color-text);
      cursor: pointer;
      transition:
        background var(--duration-fast) var(--ease-standard),
        transform var(--duration-fast) var(--ease-standard);
    }
    @media (hover: hover) {
      .device:hover {
        background: color-mix(in srgb, var(--color-text) 7%, transparent);
      }
    }
    .device:active {
      transform: scale(0.94);
    }
    .device:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      .device {
        transition-duration: 1ms;
      }
      .device:active {
        transform: none;
      }
    }
  `,
})
export class OrMiniPlayer {
  protected readonly player = inject(PlayerStore);
  protected readonly session = inject(SessionStore);
  protected readonly picker = inject(DevicePickerService);
  private readonly library = inject(LibraryStore);

  /** Name of the device (or speaker) currently playing; "This device" locally. */
  protected readonly targetName = computed(() => {
    const target = this.session.target();
    if (!target) return 'This device';
    if (target.kind === 'cast') {
      const cast = this.session
        .devices()
        .find(
          (device) =>
            device.platform === 'cast' &&
            (device.castId ?? device.id) === target.castId,
        );
      return cast?.name ?? 'speaker';
    }
    if (target.clientId === this.session.clientId()) return 'This device';
    return (
      this.session.devices().find((device) => device.id === target.clientId)
        ?.name ?? 'another device'
    );
  });

  /** Cast for a speaker, desktop for web, phone for native. */
  protected readonly deviceIcon = computed<IconName>(() => {
    const target = this.session.target();
    if (target?.kind === 'cast') return 'cast';
    const device =
      target?.kind === 'device'
        ? this.session.devices().find((item) => item.id === target.clientId)
        : undefined;
    if (device?.platform === 'web') return 'desktop';
    if (device?.platform === 'android' || device?.platform === 'ios') {
      return 'phone';
    }
    return Capacitor.isNativePlatform() ? 'phone' : 'desktop';
  });

  /** Sleeve art: provider URL, else the imported track's stored cover. */
  protected readonly art = computed(() => {
    const track = this.player.current();
    if (!track) return null;
    if (track.artUrl || !track.coverPath) return track.artUrl;
    return this.library.artUrl(track).catch(() => undefined);
  });
  /** Tapping the artwork or title. */
  readonly open = output<void>();
}
