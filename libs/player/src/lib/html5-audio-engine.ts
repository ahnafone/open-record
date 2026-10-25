import { PlaybackBlockedError } from './audio-engine';
import type {
  AudioEngine,
  AudioEngineListener,
  EngineError,
  EngineMedia,
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
 * `preload` buffers the likely next item in a spare element; when `load` asks
 * for that same URL the spare becomes the active element, so the next track
 * starts without a fresh network round trip.
 */
export class Html5AudioEngine implements AudioEngine {
  readonly ownsSystemControls = false;
  readonly wantsNeighbours = false;

  private listener: AudioEngineListener | null = null;
  private audio: HTMLAudioElement;
  private unbind: () => void;
  private spare: { audio: HTMLAudioElement; url: string } | null = null;

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
    const spare = this.spare;
    this.spare = null;
    if (spare && spare.url === url) {
      this.unbind();
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audio = spare.audio;
      this.unbind = this.bind(spare.audio);
      const d = spare.audio.duration;
      if (Number.isFinite(d) && d > 0) this.listener?.onDuration(d);
      return;
    }
    if (spare) release(spare.audio);
    this.audio.src = url;
    this.audio.load();
  }

  preload(media: EngineMedia): void {
    const url = media.source.url;
    if (this.spare?.url === url) return;
    if (this.spare) release(this.spare.audio);
    try {
      const audio = this.createAudio();
      audio.preload = 'auto';
      audio.src = url;
      audio.load();
      this.spare = { audio, url };
    } catch {
      this.spare = null;
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
      // AbortError: a newer load() interrupted this play().
      // NotSupportedError: the `error` event reports it with a proper code.
      if (
        err instanceof DOMException &&
        (err.name === 'AbortError' || err.name === 'NotSupportedError')
      ) {
        return;
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

  async stop(): Promise<void> {
    if (this.spare) release(this.spare.audio);
    this.spare = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  async destroy(): Promise<void> {
    await this.stop();
    this.unbind();
    this.listener = null;
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
