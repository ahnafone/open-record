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
  addItem(options: { item: NativeTrack; index?: number }): Promise<void>;
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
  switch (code) {
    case 1:
      return { code: 'aborted', message: 'Playback was interrupted.' };
    case 2:
      return {
        code: 'network',
        message: 'Could not reach the audio source. Check your connection.',
      };
    case 3:
      return {
        code: 'decode',
        message: 'This file is damaged or cannot be played.',
      };
    case 4:
      return {
        code: 'unsupported',
        message: 'This audio format is not supported.',
      };
    default:
      // Only unknown failures fall back to the plugin text; known Media3
      // codes always get friendly copy instead of raw diagnostics.
      return { code: 'unknown', message: message?.trim() || 'Playback failed.' };
  }
}

/** Identity of one native window; a pure refresh of the same window is a no-op. */
function windowSignature(
  media: EngineMedia,
  previous: EngineMedia | undefined,
  next: EngineMedia | undefined,
): string {
  return JSON.stringify([
    media.id,
    media.source.kind,
    media.source.url,
    media.source.mimeType ?? '',
    media.artUrl ?? '',
    previous?.id ?? '',
    next?.id ?? '',
  ]);
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
 *
 * The window is always built as `[current, next]` first and `previous` is
 * inserted at index 0 afterwards. The plugin's `setAllItems` selects index 0
 * before seeking to the requested id, which would otherwise emit a spurious
 * TRACK_CHANGED to `previous` on Android. Loads are serialized so a stale
 * window can never land after a newer one.
 */
export class NativeAudioEngine implements AudioEngine {
  readonly ownsSystemControls = true;
  readonly wantsNeighbours = true;

  private listener: AudioEngineListener | null = null;
  private readonly plugin: PlaylistPlugin;
  private ready: Promise<void> | null = null;
  private handle: PluginListenerHandle | null = null;
  private currentId: string | null = null;
  /** Id of the item the native player has actually been told to load. */
  private loadedId: string | null = null;
  private neighbours: EngineNeighbours = {};
  private endedFor: string | null = null;
  /** Last transport state reported by the OS (or requested via play/pause). */
  private playing = false;
  /** Id whose error was already reported; suppresses the plugin auto-skip. */
  private failedFor: string | null = null;
  /** Number of loads whose plugin calls are in flight. */
  private loading = 0;
  /** Serializes native playlist mutations; only the latest load applies. */
  private chain: Promise<void> = Promise.resolve();
  private loadSeq = 0;
  private windowSignature: string | null = null;

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
      isStream: media.source.kind === 'remote',
    };
  }

  async load(
    media: EngineMedia,
    neighbours: EngineNeighbours = {},
  ): Promise<void> {
    const seq = ++this.loadSeq;
    await this.init();
    // Drop neighbours that collide with the current id (one-track queues) or
    // with each other (a two-track loop reports the same item as both sides).
    const previousCandidate =
      neighbours.previous && neighbours.previous.id !== media.id
        ? neighbours.previous
        : undefined;
    const next =
      neighbours.next &&
      neighbours.next.id !== media.id &&
      neighbours.next.id !== previousCandidate?.id
        ? neighbours.next
        : undefined;
    const previous =
      previousCandidate && previousCandidate.id !== next?.id
        ? previousCandidate
        : undefined;

    const wasFailed = this.failedFor === media.id;
    // A failed current must be reloaded from scratch, never retained in place.
    const sameItem = this.loadedId === media.id && !wasFailed;
    const signature = windowSignature(media, previous, next);
    const unchanged = sameItem && this.windowSignature === signature;

    this.neighbours = { previous, next };
    this.currentId = media.id;
    if (!sameItem) this.endedFor = null;

    const task = this.chain.then(async () => {
      // A newer load was requested while this one waited its turn.
      if (seq !== this.loadSeq) return;
      if (unchanged) return;

      // Keep the failed marker until this load actually starts, so the
      // plugin's queued error auto-skip cannot be read as a user skip while
      // the previous cleanup is still running.
      this.failedFor = null;
      this.loading++;
      try {
        // Deterministic order: current is index 0, so the plugin's initial
        // selection cannot emit a TRACK_CHANGED to the previous neighbour.
        const items = [media, next]
          .filter((m): m is EngineMedia => !!m)
          .map((m) => this.toNative(m));
        const startPaused = sameItem ? !this.playing : true;
        await this.plugin.setPlaylistItems({
          items,
          options: sameItem
            ? // Same track: refresh the window, keep position and transport.
              { retainPosition: true, playFromId: media.id, startPaused }
            : // New media or retry: always start paused at the very beginning.
              {
                retainPosition: true,
                playFromId: media.id,
                playFromPosition: 0,
                startPaused: true,
              },
        });
        if (previous) {
          // Documented as non-interrupting; current stays selected.
          await this.plugin.addItem({ item: this.toNative(previous), index: 0 });
        }
        this.windowSignature = signature;
        this.loadedId = media.id;
      } finally {
        this.loading--;
      }
    });
    // Keep the chain usable on failure while still surfacing load errors.
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    await task;
  }

  async play(): Promise<void> {
    await this.init();
    this.playing = true;
    try {
      // Android 13+: ask once so the playback notification is visible.
      // Resolves even when denied, so playback is never blocked.
      await this.requestNotificationPermission();
      await this.plugin.play();
    } catch (error) {
      this.playing = false;
      throw error;
    }
  }

  async pause(): Promise<void> {
    await this.init();
    this.playing = false;
    await this.plugin.pause();
  }

  async seek(positionSec: number): Promise<void> {
    await this.init();
    await this.plugin.seekTo({ position: Math.max(0, positionSec) });
  }

  async stop(): Promise<void> {
    if (!this.ready) return;
    // Invalidate loads that were queued before the stop.
    this.loadSeq++;
    this.playing = false;
    this.failedFor = null;
    const task = this.chain.then(async () => {
      await this.plugin.clearAllItems();
    });
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      await task;
    } finally {
      this.currentId = null;
      this.loadedId = null;
      this.neighbours = {};
      this.endedFor = null;
      this.windowSignature = null;
    }
  }

  async destroy(): Promise<void> {
    if (!this.ready) return;
    this.loadSeq++;
    this.playing = false;
    this.failedFor = null;
    this.currentId = null;
    this.loadedId = null;
    this.neighbours = {};
    this.endedFor = null;
    this.windowSignature = null;
    await this.handle?.remove().catch(() => undefined);
    await this.plugin.release().catch(() => undefined);
    this.ready = null;
    this.handle = null;
    this.listener = null;
    this.chain = Promise.resolve();
  }

  private onStatus(status: NativeStatus): void {
    const l = this.listener;
    if (!l) return;
    const isCurrent = status.trackId === this.currentId;
    switch (status.msgType) {
      case Msg.TRACK_CHANGED: {
        const id = status.value.currentItem?.trackId;
        if (!id || id === this.currentId) return;
        // Stale transition while a load is being applied, or the plugin's
        // skipFailedItem advancing after an error we already reported.
        if (this.loading > 0 || this.failedFor) return;
        if (id === this.neighbours.next?.id) {
          this.currentId = id;
          // The native player has already moved: a follow-up load of this id
          // must refresh the window in place rather than restart at 0.
          this.loadedId = id;
          l.onSkipped('next', id);
        } else if (id === this.neighbours.previous?.id) {
          this.currentId = id;
          this.loadedId = id;
          l.onSkipped('previous', id);
        }
        return;
      }
      case Msg.PLAYING:
        if (isCurrent) {
          this.playing = true;
          this.failedFor = null;
          l.onPlaying();
        }
        return;
      case Msg.PAUSE:
      case Msg.STOPPED:
        if (isCurrent) {
          this.playing = false;
          l.onPaused();
        }
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
          !this.failedFor &&
          this.endedFor !== this.currentId &&
          (isCurrent || status.msgType === Msg.PLAYLIST_COMPLETED)
        ) {
          this.endedFor = this.currentId;
          l.onEnded();
        }
        return;
      case Msg.ERROR: {
        if (!isCurrent && status.trackId !== 'NONE') return;
        const failedId = this.currentId ?? status.trackId;
        // One report per failed item; the plugin may repeat the error.
        if (this.failedFor === failedId) return;
        this.failedFor = failedId;
        this.playing = false;
        this.windowSignature = null;
        // The cleanup below empties the native playlist.
        this.loadedId = null;
        l.onError(mapError(status.value.code, status.value.message));
        // The plugin auto-skips failed items. Drop the whole playlist so the
        // notification cannot stay parked on the next song; the owner reloads
        // whichever track it actually wants next.
        const cleanup = this.chain.then(async () => {
          try {
            await this.plugin.pause();
          } catch {
            // Best effort; clearing below is what matters.
          }
          try {
            await this.plugin.clearAllItems();
          } catch {
            // Nothing else we can do natively.
          }
        });
        this.chain = cleanup.then(
          () => undefined,
          () => undefined,
        );
        return;
      }
    }
  }
}
