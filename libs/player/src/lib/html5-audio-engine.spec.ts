import type { AudioEngineListener, EngineMedia } from './audio-engine';
import {
  Html5AudioEngine,
  type Html5AudioEngineOptions,
} from './html5-audio-engine';

/** Just enough of HTMLAudioElement for the engine's element logic. */
class FakeAudio {
  src = '';
  preload = '';
  volume = 1;
  currentTime = 0;
  duration = Number.NaN;
  ended = false;
  paused = true;
  error: MediaError | null = null;
  plays = 0;
  loads = 0;
  private handlers = new Map<string, Set<() => void>>();

  addEventListener(type: string, fn: () => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.handlers.get(type)?.delete(fn);
  }
  /** Dispatch a media event to the listeners bound right now. */
  emit(type: string): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn();
  }
  getAttribute(name: string): string | null {
    return name === 'src' ? this.src : null;
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  load(): void {
    this.loads++;
  }
  pause(): void {
    this.paused = true;
  }
  async play(): Promise<void> {
    this.plays++;
    this.paused = false;
  }
}

const media = (id: string): EngineMedia => ({
  id,
  source: { kind: 'bundled', url: `/${id}.mp3` },
  title: id,
  artist: 'Artist',
});

function setup(options?: Html5AudioEngineOptions) {
  const active = new FakeAudio();
  const created: FakeAudio[] = [];
  const engine = new Html5AudioEngine(
    active as unknown as HTMLAudioElement,
    () => {
      const audio = new FakeAudio();
      created.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
    options,
  );
  return { engine, active, created };
}

/**
 * Load an item. When the load stages a new element, mark it ready (its
 * `canplay` swaps it in). A reuse or spare hit creates nothing and resolves at
 * once.
 */
async function loadItem(
  engine: Html5AudioEngine,
  created: FakeAudio[],
  item: EngineMedia,
): Promise<void> {
  const before = created.length;
  const pending = engine.load(item);
  if (created.length > before) created[created.length - 1].emit('canplay');
  await pending;
}

function listenerMock(): AudioEngineListener {
  return {
    onPlaying: vi.fn(),
    onPaused: vi.fn(),
    onTime: vi.fn(),
    onDuration: vi.fn(),
    onEnded: vi.fn(),
    onError: vi.fn(),
    onSkipped: vi.fn(),
  };
}

describe('Html5AudioEngine spares', () => {
  it('reuses the warm element for both the next and the previous load', async () => {
    const { engine, active, created } = setup();
    await loadItem(engine, created, media('b'));
    engine.preload({ previous: media('a'), next: media('c') });
    expect(created.map((a) => a.src)).toEqual(['/a.mp3', '/c.mp3']);

    // Skip forward: the next spare becomes the active element.
    await loadItem(engine, created, media('c'));
    await engine.play();
    expect(created[1].plays).toBe(1);
    expect(active.plays).toBe(0);

    // The previous spare stayed warm, so going back adopts it too.
    await loadItem(engine, created, media('a'));
    await engine.play();
    expect(created[0].plays).toBe(1);
    expect(created).toHaveLength(2);
  });

  it('skip next then back reuses the original element without reloading it', async () => {
    const { engine, active, created } = setup();
    await loadItem(engine, created, media('b'));
    engine.preload({ previous: media('a'), next: media('c') });
    const loadsBefore = active.loads;

    await loadItem(engine, created, media('c'));
    engine.preload({ previous: media('b'), next: media('d') });
    await loadItem(engine, created, media('b'));
    await engine.play();

    // The outgoing `b` element was parked, not discarded: same element, no new
    // request, and it plays from the start.
    expect(active.src).toBe('/b.mp3');
    expect(active.loads).toBe(loadsBefore);
    expect(active.plays).toBe(1);
    expect(active.currentTime).toBe(0);
  });

  it('releases spares that leave the window and never buffers the loaded URL', async () => {
    const { engine, created } = setup();
    await loadItem(engine, created, media('b'));
    engine.preload({ previous: media('a'), next: media('c') });

    engine.preload({ next: media('c'), previous: media('b') });
    // `a` left the window (released); `b` is loaded, so it gets no spare.
    expect(created.map((a) => a.src)).toEqual(['', '/c.mp3']);
  });

  it('releases every spare and the parked element on stop', async () => {
    const { engine, created } = setup();
    await loadItem(engine, created, media('b'));
    engine.preload({ previous: media('a'), next: media('c') });
    await loadItem(engine, created, media('c'));

    await engine.stop();
    expect(created.every((a) => a.src === '')).toBe(true);
  });

  it('a non-spare load while audible stages a fresh element', async () => {
    const { engine, created } = setup();
    await loadItem(engine, created, media('b'));
    await engine.play();
    engine.preload({ previous: media('a'), next: media('c') });
    const before = created.length;

    // `z` is not a neighbour: it is staged in a new element.
    await loadItem(engine, created, media('z'));
    await engine.play();
    expect(created).toHaveLength(before + 1);
    expect(created.at(-1)?.src).toBe('/z.mp3');
    expect(created.at(-1)?.plays).toBe(1);
  });

  it('does not adopt a spare whose element errored, and rebuffers it on preload', async () => {
    const { engine, active, created } = setup();
    await loadItem(engine, created, media('b'));
    engine.preload({ previous: media('a'), next: media('c') });
    created[1].error = { code: 2, message: 'net' } as unknown as MediaError;

    // Nothing is audible, so the item reuses the active element.
    await loadItem(engine, created, media('c'));
    await engine.play();
    expect(created[1].plays).toBe(0);
    expect(created[1].src).toBe('');
    expect(active.src).toBe('/c.mp3');
    expect(active.plays).toBe(1);

    // A miss drops every spare, so the next window buffers `d` fresh.
    engine.preload({ previous: media('c'), next: media('d') });
    expect(created.at(-1)?.src).toBe('/d.mp3');
  });
});

describe('Html5AudioEngine overlapping loads', () => {
  it('keeps the old media playing until the new one can play, then swaps', async () => {
    const { engine, active, created } = setup();
    await loadItem(engine, created, media('a'));
    await engine.play();

    const pending = engine.load(media('b'));
    expect(active.paused).toBe(false);
    expect(created[0].src).toBe('/b.mp3');
    expect(created[0].plays).toBe(0);

    created[0].emit('canplay');
    await pending;
    expect(active.paused).toBe(true);
    await engine.play();
    expect(created[0].plays).toBe(1);
  });

  it('old ended during staging never reaches the listener', async () => {
    const { engine, active, created } = setup();
    const listener = listenerMock();
    engine.setListener(listener);
    await loadItem(engine, created, media('a'));
    await engine.play();

    active.emit('ended');
    expect(listener.onEnded).toHaveBeenCalledTimes(1);

    const pending = engine.load(media('b'));
    active.emit('ended');
    expect(listener.onEnded).toHaveBeenCalledTimes(1);
    created[0].emit('canplay');
    await pending;
  });

  it('a second load cancels the first staging element', async () => {
    const { engine, created } = setup();
    await loadItem(engine, created, media('a'));
    await engine.play();

    const first = engine.load(media('b')).catch((err: unknown) => err);
    const second = engine.load(media('c'));

    expect(await first).toMatchObject({ code: 'aborted' });
    expect(created[0].src).toBe('');
    created[1].emit('canplay');
    await second;
    expect(created[1].src).toBe('/c.mp3');
  });

  it('a failed staging load rejects, releases, and leaves the old media unbound', async () => {
    const { engine, active, created } = setup();
    const listener = listenerMock();
    engine.setListener(listener);
    await loadItem(engine, created, media('a'));
    await engine.play();

    const pending = engine.load(media('b')).catch((err: unknown) => err);
    created[0].error = { code: 4, message: 'bad' } as unknown as MediaError;
    created[0].emit('error');

    expect(await pending).toMatchObject({ code: 'unsupported' });
    expect(created[0].src).toBe('');
    expect(active.src).toBe('/a.mp3');
    expect(active.paused).toBe(false);
    // The old media stays unbound, so its events never reach the listener.
    active.emit('ended');
    expect(listener.onEnded).not.toHaveBeenCalled();
  });

  it('a retry after a failed staging stages again and rebinds on swap', async () => {
    const { engine, active, created } = setup();
    const listener = listenerMock();
    engine.setListener(listener);
    await loadItem(engine, created, media('a'));
    await engine.play();

    const failed = engine.load(media('b')).catch((err: unknown) => err);
    created[0].error = { code: 4, message: 'bad' } as unknown as MediaError;
    created[0].emit('error');
    await failed;

    // Still audible, so the retry stages a fresh element.
    await loadItem(engine, created, media('b'));
    expect(created).toHaveLength(2);
    expect(created[1].src).toBe('/b.mp3');
    await engine.play();
    expect(created[1].plays).toBe(1);

    // The swapped-in element is bound: its `ended` reaches the listener.
    created[1].emit('ended');
    expect(listener.onEnded).toHaveBeenCalledTimes(1);
    // The old element stays unbound.
    active.emit('ended');
    expect(listener.onEnded).toHaveBeenCalledTimes(1);
  });

  it('a failed staging after an interrupted fade restores the active volume', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const { engine, created } = setup();
      engine.setCrossfade(1);
      await loadItem(engine, created, media('a'));
      await engine.play();

      const pending = engine.load(media('b'));
      created[0].emit('canplay');
      await pending;
      await engine.play();
      now = 500;
      vi.advanceTimersByTime(30);
      expect(created[0].volume).toBeLessThan(1);

      // A second load interrupts the fade, then its staging fails.
      const second = engine.load(media('c')).catch((err: unknown) => err);
      created[1].error = { code: 4, message: 'bad' } as unknown as MediaError;
      created[1].emit('error');

      expect(await second).toMatchObject({ code: 'unsupported' });
      expect(created[0].volume).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stop() during staging rejects with aborted and releases the staged element', async () => {
    const { engine, created } = setup();
    await loadItem(engine, created, media('a'));
    await engine.play();

    const pending = engine.load(media('b')).catch((err: unknown) => err);
    expect(created[0].src).toBe('/b.mp3');
    await engine.stop();

    expect(await pending).toMatchObject({ code: 'aborted' });
    expect(created[0].src).toBe('');
  });

  it('gives up a staged load that never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const { engine, active, created } = setup();
      await loadItem(engine, created, media('a'));
      await engine.play();

      const pending = engine.load(media('b')).catch((err: unknown) => err);
      vi.advanceTimersByTime(15_000);

      expect(await pending).toMatchObject({ code: 'network' });
      expect(created[0].src).toBe('');
      expect(active.paused).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('crossfades on the clock, so a late tick still ends the ramp', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const { engine, active, created } = setup();
      engine.setCrossfade(1);
      await loadItem(engine, created, media('a'));
      await engine.play();

      const pending = engine.load(media('b'));
      created[0].emit('canplay');
      await pending;
      expect(active.paused).toBe(false);
      expect(created[0].volume).toBe(0);

      await engine.play();
      now = 500;
      vi.advanceTimersByTime(30);
      expect(active.volume).toBeGreaterThan(0);
      expect(active.volume).toBeLessThan(1);
      expect(created[0].volume).toBeGreaterThan(0);
      expect(created[0].volume).toBeLessThan(1);

      // Ticks were throttled: the next one lands long after the fade is due.
      now = 5000;
      vi.advanceTimersByTime(30);
      expect(active.volume).toBe(0);
      expect(active.paused).toBe(true);
      expect(created[0].volume).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('Html5AudioEngine without volume control (iOS)', () => {
  it('reuses the active element even while audible, so nothing is staged', async () => {
    const { engine, active, created } = setup({ volumeSupported: false });
    await loadItem(engine, created, media('a'));
    await engine.play();

    await loadItem(engine, created, media('b'));
    await engine.play();
    expect(created).toHaveLength(0);
    expect(active.src).toBe('/b.mp3');
    expect(active.plays).toBe(2);
  });

  it('a crossfade request becomes a hard cut', async () => {
    const { engine, active, created } = setup({ volumeSupported: false });
    engine.setCrossfade(1);
    await loadItem(engine, created, media('a'));
    await engine.play();

    await loadItem(engine, created, media('b'));
    await engine.play();
    expect(created).toHaveLength(0);
    expect(active.src).toBe('/b.mp3');
    expect(active.volume).toBe(1);
  });
});
