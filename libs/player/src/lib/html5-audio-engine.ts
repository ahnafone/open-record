import { PlaybackBlockedError } from './audio-engine';
import type {
  AudioEngine,
  AudioEngineListener,
  EngineError,
  EngineMedia,
  EngineNeighbours,
} from './audio-engine';

function mapMediaError(error: MediaError | null): EngineError {
  switch (error?.code) {
    case 1:
      return { code: 'aborted', message: 'Playback was aborted.' };
    case 2:
      return { code: 'network', message: 'A network error stopped playback.' };
    case 3:
      return { code: 'decode', message: 'This audio could not be decoded.' };
    case 4:
      return {
        code: 'unsupported',
        message: 'This audio format is not supported.',
      };
    default:
      return {
        code: 'unknown',
        message: error?.message || 'Playback failed.',
      };
  }
}

/**
 * HTML5 <audio> engine. Used on the web and as the fallback when the native
 * plugin is not installed. OS controls come from MediaSessionController.
 *
 * `preload` buffers the previous and next items in spare elements (one per
 * URL, at most two); when `load` asks for one of those URLs the spare becomes
 * the active element, so that track starts without a fresh network round trip.
 */
export class Html5AudioEngine implements AudioEngine {
  readonly ownsSystemControls = false;
  readonly wantsNeighbours = false;

  private listener: AudioEngineListener | null = null;
  private audio: HTMLAudioElement;
  private unbind: () => void;
  /** Warm spare elements keyed by source URL. */
  private spares = new Map<string, HTMLAudioElement>();
  /** URL of the item currently loaded into the active element. */
  private currentUrl = '';
  private volume = 1;

  constructor(
    audio: HTMLAudioElement = new Audio(),
    private readonly createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {
    this.audio = audio;
    this.audio.preload = 'auto';
    this.unbind = this.bind(audio);
  }

  setListener(listener: AudioEngineListener | null): void {
    this.listener = listener;
  }

  async load(media: EngineMedia): Promise<void> {
    const url = media.source.url;
    const spare = this.spares.get(url);
    if (spare) this.spares.delete(url);

    if (spare && !spare.error) {
      // Skip to a neighbour: adopt its warm element (already buffered, so no
      // new request) and park the outgoing one for a skip back.
      const outgoing = this.audio;
      const outgoingUrl = this.currentUrl;
      this.unbind();
      this.retire(outgoing, outgoingUrl, url);
      this.audio = spare;
      this.currentUrl = url;
      this.audio.volume = this.volume;
      this.unbind = this.bind(spare);
      const d = spare.duration;
      if (Number.isFinite(d) && d > 0) this.listener?.onDuration(d);
      return;
    }
    // Miss, or a spare that failed: reuse the active element (it was unlocked
    // by the user's gesture, which matters for iOS autoplay) and drop the
    // spares, since the window is unknown until the next preload().
    if (spare) release(spare);
    this.releaseSpares();
    this.currentUrl = url;
    this.audio.src = url;
    this.audio.load();
  }

  /**
   * Park the element that was playing when a spare is adopted, so a skip back
   * reuses it with no new request. It is kept paused, unbound and rewound.
   * Released instead when it failed or nothing was loaded. The map is capped at
   * two entries.
   */
  private retire(audio: HTMLAudioElement, url: string, incomingUrl: string): void {
    audio.pause();
    if (!url || url === incomingUrl || audio.error) {
      release(audio);
      return;
    }
    const older = this.spares.get(url);
    if (older) release(older);
    this.spares.delete(url);
    for (const [oldUrl, old] of this.spares) {
      if (this.spares.size < 2) break;
      release(old);
      this.spares.delete(oldUrl);
    }
    try {
      audio.currentTime = 0;
    } catch {
      // Rewind is best effort; playback then starts from the element's position.
    }
    this.spares.set(url, audio);
  }

  /**
   * Make the spares match the neighbour window: buffer each wanted URL that is
   * not held yet (held ones are kept as they are), and release spares that are
   * no longer wanted. The currently loaded URL never gets a spare.
   */
  preload(neighbours: EngineNeighbours): void {
    const wanted = new Set<string>();
    for (const media of [neighbours.previous, neighbours.next]) {
      const url = media?.source.url;
      if (url && url !== this.currentUrl) wanted.add(url);
    }
    for (const [url, audio] of this.spares) {
      if (!wanted.has(url)) {
        release(audio);
        this.spares.delete(url);
      }
    }
    for (const url of wanted) {
      const held = this.spares.get(url);
      if (held && !held.error) continue;
      if (held) {
        // A failed spare is a miss: drop it and buffer a fresh one.
        release(held);
        this.spares.delete(url);
      }
      try {
        const audio = this.createAudio();
        audio.preload = 'auto';
        audio.src = url;
        audio.load();
        this.spares.set(url, audio);
      } catch {
        // Best effort: without a spare the later load simply fetches normally.
      }
    }
  }

  async play(): Promise<void> {
    try {
      await this.audio.play();
    } catch (err) {
      // Autoplay policy rejections surface as NotAllowedError.
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        throw new PlaybackBlockedError();
      }
      // AbortError: a newer load() interrupted this play(); not a failure.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      // NotSupportedError: an `error` event may never follow when the element
      // is already in an error state, so report the failure here instead.
      if (err instanceof DOMException && err.name === 'NotSupportedError') {
        throw this.audio.error
          ? mapMediaError(this.audio.error)
          : {
              code: 'unsupported',
              message: 'This audio format is not supported.',
            };
      }
      throw err;
    }
  }

  async pause(): Promise<void> {
    this.audio.pause();
  }

  async seek(positionSec: number): Promise<void> {
    this.audio.currentTime = Math.max(0, positionSec);
    this.listener?.onTime(this.audio.currentTime);
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.audio.volume = this.volume;
  }

  async stop(): Promise<void> {
    this.releaseSpares();
    this.currentUrl = '';
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  async destroy(): Promise<void> {
    await this.stop();
    this.unbind();
    this.listener = null;
  }

  private releaseSpares(): void {
    for (const audio of this.spares.values()) release(audio);
    this.spares.clear();
  }

  /** Forward an element's media events to the listener. */
  private bind(audio: HTMLAudioElement): () => void {
    const on = <K extends keyof HTMLMediaElementEventMap>(
      type: K,
      fn: () => void,
    ): (() => void) => {
      audio.addEventListener(type, fn);
      return () => audio.removeEventListener(type, fn);
    };
    const offs = [
      on('playing', () => this.listener?.onPlaying()),
      on('pause', () => {
        // `pause` also fires right before `ended`; let `ended` win.
        if (!audio.ended) this.listener?.onPaused();
      }),
      on('timeupdate', () => this.listener?.onTime(audio.currentTime)),
      on('durationchange', () => {
        const d = audio.duration;
        if (Number.isFinite(d) && d > 0) this.listener?.onDuration(d);
      }),
      on('ended', () => this.listener?.onEnded()),
      on('error', () => {
        // An empty src after stop() is not a user-facing failure.
        if (!audio.getAttribute('src')) return;
        this.listener?.onError(mapMediaError(audio.error));
      }),
    ];
    return () => offs.forEach((off) => off());
  }
}

/** Drop a spare element's source so it stops buffering. */
function release(audio: HTMLAudioElement): void {
  try {
    audio.removeAttribute('src');
    audio.load();
  } catch {
    // Already released.
  }
}
