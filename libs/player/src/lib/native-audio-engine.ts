import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { PlayableSource } from '@open-record/models';
import type {
  AudioEngine,
  AudioEngineListener,
  EngineError,
  EngineMedia,
  EngineNeighbours,
} from './audio-engine';
import { requestPlaybackNotificationPermission } from './notification-permission';
import type { NotificationPermissionRequester } from './notification-permission';

/*
 * Minimal local typing of `capacitor-plugin-playlist` (8.x), checked against
 * its published `dist/esm/definitions.d.ts`. Kept local so the library does
 * not pull the plugin's web implementation into the bundle; the native side
 * is registered as `Playlist`.
 */
interface NativeTrack {
  trackId: string;
  assetUrl: string;
  title: string;
  artist: string;
  album: string;
  albumArt?: string;
  mimeType?: string;
  isStream?: boolean;
}

interface NativeStatus {
  trackId: string;
  msgType: number;
  value: {
    currentPosition?: number;
    duration?: number;
    code?: number;
    message?: string;
    currentItem?: { trackId?: string } | null;
  };
}

interface PlaylistPlugin {
  initialize(): Promise<void>;
  release(): Promise<void>;
  setOptions(options: { verbose?: boolean }): Promise<void>;
  setPlaylistItems(options: {
    items: NativeTrack[];
    options: {
      retainPosition?: boolean;
      playFromPosition?: number;
      playFromId?: string;
      startPaused?: boolean;
    };
  }): Promise<void>;
  clearAllItems(): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(options: { position: number }): Promise<void>;
  addListener(
    eventName: 'status',
    fn: (data: { action: string; status: NativeStatus }) => void,
  ): Promise<PluginListenerHandle>;
}

export const NATIVE_PLAYLIST_PLUGIN = 'Playlist';

/** RmxAudioStatusMessage values used by the adapter. */
const Msg = {
  ERROR: 5,
  PLAYING: 30,
  PAUSE: 35,
  POSITION: 40,
  SEEK: 45,
  COMPLETED: 50,
  DURATION: 55,
  STOPPED: 60,
  TRACK_CHANGED: 100,
  PLAYLIST_COMPLETED: 105,
} as const;

function mapError(code: number | undefined, message?: string): EngineError {
  const text = message || 'Playback failed.';
  switch (code) {
    case 1:
      return { code: 'aborted', message: text };
    case 2:
      return { code: 'network', message: text };
    case 3:
      return { code: 'decode', message: text };
    case 4:
      return { code: 'unsupported', message: text };
    default:
      return { code: 'unknown', message: text };
  }
}

/**
 * Maps a PlayableSource to a URL the native player can open.
 * - Android: bundled web assets live under `asset:///public/`.
 * - WebView-converted file URLs (`/_capacitor_file_/...`) go back to file://.
 * - iOS bundled sources must already be absolute file:// URLs (see README).
 */
export function nativeUrlFor(source: PlayableSource, platform: string): string {
  const fileMarker = '/_capacitor_file_';
  const markerAt = source.url.indexOf(fileMarker);
  if (markerAt >= 0) {
    return 'file://' + source.url.slice(markerAt + fileMarker.length);
  }
  if (source.kind === 'bundled' && !/^[a-z][a-z0-9+.-]*:/i.test(source.url)) {
    const path = source.url.replace(/^\.?\//, '');
    if (platform === 'android') return `asset:///public/${path}`;
  }
  return source.url;
}

/**
 * Album art for the native player. WebView file URLs (`convertFileSrc`) are
 * mapped back to the file: iOS loads non-http art with `UIImage(contentsOfFile:)`
 * (a plain path), Android hands the URI to Glide (`file://`).
 */
export function nativeArtUrlFor(url: string, platform: string): string {
  const fileMarker = '/_capacitor_file_';
  const markerAt = url.indexOf(fileMarker);
  if (markerAt < 0) return url;
  const path = url.slice(markerAt + fileMarker.length);
  if (platform !== 'ios') return 'file://' + path;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Native engine backed by capacitor-plugin-playlist (Media3 foreground
 * service on Android, AVQueuePlayer + MPRemoteCommandCenter on iOS).
 *
 * The native playlist is kept to a window of [previous, current, next] so the
 * OS shows next/previous and can advance while the WebView is suspended.
 * PlayerEngine stays the source of truth for the queue.
 */
export class NativeAudioEngine implements AudioEngine {
  readonly ownsSystemControls = true;
  readonly wantsNeighbours = true;

  private listener: AudioEngineListener | null = null;
  private readonly plugin: PlaylistPlugin;
  private ready: Promise<void> | null = null;
  private handle: PluginListenerHandle | null = null;
  private currentId: string | null = null;
  private neighbours: EngineNeighbours = {};
  private endedFor: string | null = null;

  constructor(
    plugin: PlaylistPlugin = registerPlugin<PlaylistPlugin>(
      NATIVE_PLAYLIST_PLUGIN,
    ),
    private readonly platform: string = Capacitor.getPlatform(),
    private readonly requestNotificationPermission: NotificationPermissionRequester = requestPlaybackNotificationPermission,
  ) {
    this.plugin = plugin;
  }

  static isAvailable(): boolean {
    return (
      Capacitor.isNativePlatform() &&
      Capacitor.isPluginAvailable(NATIVE_PLAYLIST_PLUGIN)
    );
  }

  setListener(listener: AudioEngineListener | null): void {
    this.listener = listener;
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await this.plugin.setOptions({ verbose: false });
      await this.plugin.initialize();
      this.handle = await this.plugin.addListener('status', ({ status }) =>
        this.onStatus(status),
      );
    })();
    return this.ready;
  }

  private toNative(media: EngineMedia): NativeTrack {
    return {
      trackId: media.id,
      assetUrl: nativeUrlFor(media.source, this.platform),
      title: media.title,
      artist: media.artist,
      album: media.album ?? '',
      albumArt: media.artUrl && nativeArtUrlFor(media.artUrl, this.platform),
      mimeType: media.source.mimeType,
      isStream: false,
    };
  }

  async load(
    media: EngineMedia,
    neighbours: EngineNeighbours = {},
  ): Promise<void> {
    await this.init();
    // Drop neighbours that collide with the current id (one-track queues).
    const previous =
      neighbours.previous && neighbours.previous.id !== media.id
        ? neighbours.previous
        : undefined;
    const next =
      neighbours.next &&
      neighbours.next.id !== media.id &&
      neighbours.next.id !== previous?.id
        ? neighbours.next
        : undefined;
    const sameItem = this.currentId === media.id;
    this.neighbours = { previous, next };
    this.currentId = media.id;
    if (!sameItem) this.endedFor = null;

    const items = [previous, media, next]
      .filter((m): m is EngineMedia => !!m)
      .map((m) => this.toNative(m));
    await this.plugin.setPlaylistItems({
      items,
      options: sameItem
        ? // The native side already moved here: only refresh the window.
          { retainPosition: true, playFromId: media.id }
        : {
            retainPosition: true,
            playFromId: media.id,
            playFromPosition: 0,
            startPaused: true,
          },
    });
  }

  async play(): Promise<void> {
    await this.init();
    // Android 13+: ask once so the playback notification is visible.
    // Resolves even when denied, so playback is never blocked.
    await this.requestNotificationPermission();
    await this.plugin.play();
  }

  async pause(): Promise<void> {
    await this.init();
    await this.plugin.pause();
  }

  async seek(positionSec: number): Promise<void> {
    await this.init();
    await this.plugin.seekTo({ position: Math.max(0, positionSec) });
  }

  async stop(): Promise<void> {
    if (!this.ready) return;
    await this.plugin.clearAllItems();
    this.currentId = null;
    this.neighbours = {};
  }

  async destroy(): Promise<void> {
    if (!this.ready) return;
    await this.handle?.remove();
    await this.plugin.release();
    this.ready = null;
    this.handle = null;
    this.listener = null;
    this.currentId = null;
  }

  private onStatus(status: NativeStatus): void {
    const l = this.listener;
    if (!l) return;
    const isCurrent = status.trackId === this.currentId;
    switch (status.msgType) {
      case Msg.TRACK_CHANGED: {
        const id = status.value.currentItem?.trackId;
        if (!id || id === this.currentId) return;
        if (id === this.neighbours.next?.id) {
          this.currentId = id;
          l.onSkipped('next');
        } else if (id === this.neighbours.previous?.id) {
          this.currentId = id;
          l.onSkipped('previous');
        }
        return;
      }
      case Msg.PLAYING:
        if (isCurrent) l.onPlaying();
        return;
      case Msg.PAUSE:
      case Msg.STOPPED:
        if (isCurrent) l.onPaused();
        return;
      case Msg.POSITION:
      case Msg.SEEK:
        if (isCurrent && status.value.currentPosition !== undefined) {
          l.onTime(status.value.currentPosition);
        }
        return;
      case Msg.DURATION:
        if (isCurrent && status.value.duration) {
          l.onDuration(status.value.duration);
        }
        return;
      case Msg.COMPLETED:
      case Msg.PLAYLIST_COMPLETED:
        // With a `next` in the window the native player advances on its own
        // and reports TRACK_CHANGED instead.
        if (
          this.currentId &&
          !this.neighbours.next &&
          this.endedFor !== this.currentId &&
          (isCurrent || status.msgType === Msg.PLAYLIST_COMPLETED)
        ) {
          this.endedFor = this.currentId;
          l.onEnded();
        }
        return;
      case Msg.ERROR:
        if (isCurrent || status.trackId === 'NONE') {
          l.onError(mapError(status.value.code, status.value.message));
        }
        return;
    }
  }
}
