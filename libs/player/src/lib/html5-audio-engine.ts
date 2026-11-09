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

/** Gain update interval while a crossfade runs, in ms. */
const FADE_STEP_MS = 30;

/** A staged load that has not reached `canplay` by then is given up. */
const STAGING_TIMEOUT_MS = 15_000;

const noop = (): void => {
  /* nothing bound */
};

export interface Html5AudioEngineOptions {
  /**
   * Whether the element honours `volume` (iOS does not). Default: probed once
   * on the active element. Tests inject it.
   */
  volumeSupported?: boolean;
}

/** A load waiting for its staging element to reach `canplay`. */
interface Staging {
  audio: HTMLAudioElement;
  /** Stop waiting, release the element and reject the load. */
  abort(): void;
}

/** An outgoing element fading out while the active one fades in. */
interface Fade {
  outgoing: HTMLAudioElement;
  outgoingUrl: string;
  /** Set once the incoming element has started; the ramp runs from then. */
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

/**
 * HTML5 <audio> engine. Used on the web and as the fallback when the native
 * plugin is not installed. OS controls come from MediaSessionController.
 *
 * `preload` buffers the previous and next items in spare elements (one per
 * URL, at most two); when `load` asks for one of those URLs the spare becomes
 * the active element, so that track starts without a fresh network round trip.
 *
 * A miss while the active element is audible stages a fresh element. The
 * active one keeps playing until the staged element can play, then the two
 * swap, either as a hard cut or as an equal-power crossfade (`setCrossfade`).
 * A miss while nothing is audible reuses the active element, so it keeps the
 * user-gesture unlock iOS needs for `play()` after an async load.
 */
export class Html5AudioEngine implements AudioEngine {
  readonly ownsSystemControls = false;
  readonly wantsNeighbours = false;
  readonly overlapsLoad = true;

  private listener: AudioEngineListener | null = null;
  private audio: HTMLAudioElement;
  private unbind: () => void;
  /** Warm spare elements keyed by source URL. */
  private spares = new Map<string, HTMLAudioElement>();
  /** URL of the item currently loaded into the active element. */
  private currentUrl = '';
  private volume = 1;
  /** Crossfade length for swaps, in seconds. 0 is a hard cut. */
  private crossfadeSec = 0;
  /** The load currently waiting for its staged element to be ready. */
  private staging: Staging | null = null;
  /** The outgoing element still audible after a swap. */
  private fade: Fade | null = null;
  /** Cached result of the element volume check. */
  private volumeOk: boolean | undefined;

  constructor(
    audio: HTMLAudioElement = new Audio(),
    private readonly createAudio: () => HTMLAudioElement = () => new Audio(),
    private readonly options: Html5AudioEngineOptions = {},
  ) {
    this.audio = audio;
    this.audio.preload = 'auto';
    this.unbind = this.bind(audio);
  }

  setListener(listener: AudioEngineListener | null): void {
    this.listener = listener;
  }

  setCrossfade(sec: number): void {
    this.crossfadeSec = Number.isFinite(sec) && sec > 0 ? sec : 0;
  }

  async load(media: EngineMedia): Promise<void> {
    const url = media.source.url;
    const spare = this.spares.get(url);
    if (spare) this.spares.delete(url);

    // A newer load supersedes a pending one and any fade in progress. The
    // active element stays audible until the new media can play, but its
    // events are dropped now: its ticks, pause and `ended` belong to the
    // previous item and must not reach the listener.
    this.cancelStaging();
    this.cancelFade(false);
    this.unbind();
    this.unbind = noop;

    if (spare && !spare.error) {
      // Skip to a neighbour: adopt its warm element (already buffered, so no
      // new request) and park the outgoing one for a skip back.
      const outgoing = this.audio;
      const outgoingUrl = this.currentUrl;
      const fade = this.canFade(outgoing, outgoingUrl);
      this.audio = spare;
      this.currentUrl = url;
      this.bindActive();
      if (fade) {
        spare.volume = 0;
        this.beginFade(outgoing, outgoingUrl);
      } else {
        this.retire(outgoing, outgoingUrl, url);
        spare.volume = this.volume;
      }
      const d = spare.duration;
      if (Number.isFinite(d) && d > 0) this.listener?.onDuration(d);
      return;
    }
    // Miss, or a spare that failed: the window is unknown until the next
    // preload(), so drop the spares.
    if (spare) release(spare);
    this.releaseSpares();
    // Audible and volume honoured: keep it playing until the new item can play.
    // Without volume control (iOS) a staged element would not inherit the
    // user-gesture unlock, so the active element is reused as before.
    if (this.currentUrl && !this.audio.paused && this.volumeSupported(this.audio)) {
      return this.stage(url);
    }
    // Nothing audible, or no volume control: reuse the active element.
    this.audio.volume = this.volume;
    this.currentUrl = url;
    this.audio.src = url;
    this.audio.load();
    this.bindActive();
  }

  /**
   * Buffer `url` in a fresh element and resolve once it can play. Its `canplay`
   * swaps it in. `error` and a stall past STAGING_TIMEOUT_MS reject and release
   * it. A newer load or stop aborts it, rejecting with `aborted`.
   */
  private stage(url: string): Promise<void> {
    const audio = this.createAudio();
    audio.preload = 'auto';
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const detach = () => {
        if (timer !== null) clearTimeout(timer);
        audio.removeEventListener('canplay', onCanPlay);
        audio.removeEventListener('error', onError);
      };
      /** Ends this attempt, unless a newer load already superseded it. */
      const claim = (): boolean => {
        if (this.staging?.audio !== audio) return false;
        this.staging = null;
        detach();
        return true;
      };
      /**
       * The staged element failed or was dropped. The old media stays unbound:
       * a retry backoff must not let its ended/playing/error reach PlayerEngine.
       * The next load() rebinds whichever element it leaves active.
       */
      const abandon = (err: EngineError) => {
        release(audio);
        // The active element may have been left at a mid-fade gain.
        if (!this.fade) this.audio.volume = this.volume;
        reject(err);
      };
      const onCanPlay = () => {
        if (!claim()) return;
        this.swapIn(audio, url);
        resolve();
      };
      const onError = () => {
        if (claim()) abandon(mapMediaError(audio.error));
      };
      this.staging = {
        audio,
        abort: () => {
          detach();
          abandon({ code: 'aborted', message: 'Load was cancelled.' });
        },
      };
      timer = setTimeout(() => {
        if (claim()) {
          abandon({
            code: 'network',
            message: 'This audio took too long to load.',
          });
        }
      }, STAGING_TIMEOUT_MS);
      audio.addEventListener('canplay', onCanPlay);
      audio.addEventListener('error', onError);
      audio.src = url;
      audio.load();
    });
  }

  private cancelStaging(): void {
    const staging = this.staging;
    if (!staging) return;
    this.staging = null;
    staging.abort();
  }

  /**
   * Make a staged element the active one. The outgoing element is parked (a
   * skip back reuses it) as a hard cut, or faded out when crossfading and it
   * is still audible. Crossfade starts on `play()`, not here.
   */
  private swapIn(incoming: HTMLAudioElement, url: string): void {
    const outgoing = this.audio;
    const outgoingUrl = this.currentUrl;
    const fade = this.canFade(outgoing, outgoingUrl);
    this.audio = incoming;
    this.currentUrl = url;
    this.bindActive();
    if (fade) {
      incoming.volume = 0;
      this.beginFade(outgoing, outgoingUrl);
    } else {
      this.retire(outgoing, outgoingUrl, url);
      incoming.volume = this.volume;
    }
    const d = incoming.duration;
    if (Number.isFinite(d) && d > 0) this.listener?.onDuration(d);
  }

  /** (Re)bind the listener to the active element, dropping any old binding. */
  private bindActive(): void {
    this.unbind();
    this.unbind = this.bind(this.audio);
  }

  /** A fade is wanted: crossfade set, outgoing audible, and volume honoured. */
  private canFade(outgoing: HTMLAudioElement, outgoingUrl: string): boolean {
    return (
      this.crossfadeSec > 0 &&
      !outgoing.paused &&
      outgoingUrl !== '' &&
      this.volumeSupported(outgoing)
    );
  }

  /**
   * Whether the element honours `volume`. Probed once on the element given,
   * then the value is restored. iOS ignores volume, so a fade there would be a
   * hard cut with a wrong ramp: the caller falls back to a hard swap.
   */
  private volumeSupported(probe: HTMLAudioElement): boolean {
    if (this.volumeOk === undefined) {
      this.volumeOk =
        this.options.volumeSupported ?? probeVolume(probe);
    }
    return this.volumeOk;
  }

  /** Arm a fade; `play()` starts the ramp once the incoming element runs. */
  private beginFade(outgoing: HTMLAudioElement, outgoingUrl: string): void {
    this.fade = { outgoing, outgoingUrl, started: false, timer: null };
  }

  /**
   * Equal-power ramp, timed by the clock rather than by ticks: a throttled
   * background tab can delay ticks, but the fade still ends on time.
   */
  private startFade(fade: Fade): void {
    fade.started = true;
    const durationMs = this.crossfadeSec * 1000;
    const startedAt = performance.now();
    fade.timer = setInterval(() => {
      const t = Math.min(1, (performance.now() - startedAt) / durationMs);
      const angle = (t * Math.PI) / 2;
      fade.outgoing.volume = clampGain(this.volume * Math.cos(angle));
      this.audio.volume = clampGain(this.volume * Math.sin(angle));
      if (t >= 1) this.endFade(fade);
    }, FADE_STEP_MS);
  }

  private endFade(fade: Fade): void {
    if (fade.timer !== null) clearInterval(fade.timer);
    fade.timer = null;
    if (this.fade !== fade) return;
    this.fade = null;
    // Land exactly on the end values (cos/sin are not exact at the ends).
    this.audio.volume = this.volume;
    fade.outgoing.volume = 0;
    this.retire(fade.outgoing, fade.outgoingUrl, this.currentUrl);
  }

  /**
   * Stop a fade: the outgoing element is released. `restoreVolume` gives the
   * active element full gain again; pass false when it is about to become the
   * outgoing element of a new fade and must keep its current gain.
   */
  private cancelFade(restoreVolume = true): void {
    const fade = this.fade;
    if (!fade) return;
    this.fade = null;
    if (fade.timer !== null) clearInterval(fade.timer);
    fade.outgoing.pause();
    release(fade.outgoing);
    if (restoreVolume) this.audio.volume = this.volume;
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
      // A start that fails must not leave the outgoing media fading out.
      this.cancelFade();
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
    const fade = this.fade;
    if (fade && !fade.started) this.startFade(fade);
  }

  async pause(): Promise<void> {
    this.cancelFade();
    this.audio.pause();
  }

  async seek(positionSec: number): Promise<void> {
    this.audio.currentTime = Math.max(0, positionSec);
    this.listener?.onTime(this.audio.currentTime);
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    // A running fade ramps to the current volume on its next step.
    if (!this.fade) this.audio.volume = this.volume;
  }

  async stop(): Promise<void> {
    this.cancelStaging();
    this.cancelFade();
    this.releaseSpares();
    this.currentUrl = '';
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  async destroy(): Promise<void> {
    await this.stop();
    this.unbind();
    this.unbind = noop;
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

/** Set a gain on the element and read it back; restores the old value. */
function probeVolume(audio: HTMLAudioElement): boolean {
  try {
    const before = audio.volume;
    audio.volume = 0.5;
    const honoured = audio.volume === 0.5;
    audio.volume = before;
    return honoured;
  } catch {
    return false;
  }
}

function clampGain(gain: number): number {
  return Math.min(1, Math.max(0, gain));
}

/** Drop an element's source so it stops buffering or playing. */
function release(audio: HTMLAudioElement): void {
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch {
    // Already released.
  }
}
