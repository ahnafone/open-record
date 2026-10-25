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
 */
export class Html5AudioEngine implements AudioEngine {
  readonly ownsSystemControls = false;
  readonly wantsNeighbours = false;

  private listener: AudioEngineListener | null = null;
  private readonly audio: HTMLAudioElement;
  private readonly unbind: () => void;

  constructor(audio: HTMLAudioElement = new Audio()) {
    this.audio = audio;
    this.audio.preload = 'auto';
    const on = <K extends keyof HTMLMediaElementEventMap>(
      type: K,
      fn: () => void,
    ): (() => void) => {
      this.audio.addEventListener(type, fn);
      return () => this.audio.removeEventListener(type, fn);
    };
    const offs = [
      on('playing', () => this.listener?.onPlaying()),
      on('pause', () => {
        // `pause` also fires right before `ended`; let `ended` win.
        if (!this.audio.ended) this.listener?.onPaused();
      }),
      on('timeupdate', () => this.listener?.onTime(this.audio.currentTime)),
      on('durationchange', () => {
        const d = this.audio.duration;
        if (Number.isFinite(d) && d > 0) this.listener?.onDuration(d);
      }),
      on('ended', () => this.listener?.onEnded()),
      on('error', () => {
        // An empty src after stop() is not a user-facing failure.
        if (!this.audio.getAttribute('src')) return;
        this.listener?.onError(mapMediaError(this.audio.error));
      }),
    ];
    this.unbind = () => offs.forEach((off) => off());
  }

  setListener(listener: AudioEngineListener | null): void {
    this.listener = listener;
  }

  async load(media: EngineMedia): Promise<void> {
    this.audio.src = media.source.url;
    this.audio.load();
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
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  async destroy(): Promise<void> {
    await this.stop();
    this.unbind();
    this.listener = null;
  }
}
