import type {
  AudioEngineListener,
  EngineError,
  EngineMedia,
} from './audio-engine';
import { NativeAudioEngine } from './native-audio-engine';

/*
 * Fake `capacitor-plugin-playlist` registration. It records the calls the
 * engine makes and lets a test push native status events through the listener
 * the engine registered. `NativeAudioEngine`'s plugin interface is private, so
 * the fake is passed through `as never`, like the plugin registration itself.
 */

interface FakeStatusValue {
  currentPosition?: number;
  duration?: number;
  code?: number;
  message?: string;
  currentItem?: { trackId?: string } | null;
}

interface FakeStatus {
  trackId: string;
  msgType: number;
  value: FakeStatusValue;
}

interface FakeCall {
  method: string;
  options?: {
    items?: { trackId?: string }[];
    options?: Record<string, unknown>;
    item?: { trackId?: string };
    index?: number;
    position?: number;
  };
}

const Msg = {
  ERROR: 5,
  PLAYING: 30,
  PAUSE: 35,
  COMPLETED: 50,
  TRACK_CHANGED: 100,
} as const;

class FakePlaylistPlugin {
  readonly calls: FakeCall[] = [];
  /** Track ids of every window applied with `setPlaylistItems`. */
  readonly windows: string[][] = [];
  /** `{ id, index }` of every `addItem` insertion. */
  readonly added: { id: string; index?: number }[] = [];
  /** When set, `setPlaylistItems` waits on it so a load can be kept in flight. */
  gate: Promise<void> | null = null;
  private listener:
    | ((data: { action: string; status: FakeStatus }) => void)
    | null = null;

  async setOptions(): Promise<void> {
    /* no-op */
  }
  async initialize(): Promise<void> {
    /* no-op */
  }
  async release(): Promise<void> {
    this.calls.push({ method: 'release' });
  }
  async setPlaylistItems(options: {
    items: { trackId?: string }[];
    options: Record<string, unknown>;
  }): Promise<void> {
    this.calls.push({ method: 'setPlaylistItems', options });
    if (this.gate) await this.gate;
    this.windows.push(options.items.map((item) => item.trackId ?? ''));
  }
  async addItem(options: {
    item: { trackId?: string };
    index?: number;
  }): Promise<void> {
    this.calls.push({ method: 'addItem', options });
    this.added.push({
      id: options.item.trackId ?? '',
      index: options.index,
    });
  }
  async clearAllItems(): Promise<void> {
    this.calls.push({ method: 'clearAllItems' });
  }
  async play(): Promise<void> {
    this.calls.push({ method: 'play' });
  }
  async pause(): Promise<void> {
    this.calls.push({ method: 'pause' });
  }
  async seekTo(options: { position: number }): Promise<void> {
    this.calls.push({ method: 'seekTo', options });
  }
  async addListener(
    _event: 'status',
    fn: (data: { action: string; status: FakeStatus }) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    this.listener = fn;
    return {
      remove: async () => {
        this.listener = null;
      },
    };
  }

  emit(trackId: string, msgType: number, value: FakeStatusValue = {}): void {
    this.listener?.({ action: 'status', status: { trackId, msgType, value } });
  }
  trackChanged(id: string): void {
    this.emit(id, Msg.TRACK_CHANGED, { currentItem: { trackId: id } });
  }
  error(trackId: string, code?: number, message?: string): void {
    this.emit(trackId, Msg.ERROR, { code, message });
  }
  playing(trackId: string): void {
    this.emit(trackId, Msg.PLAYING);
  }
}

const media = (id: string): EngineMedia => ({
  id,
  source: { url: `/music/${id}.mp3`, kind: 'file', mimeType: 'audio/mpeg' },
  title: `Title ${id}`,
  artist: 'Artist',
  album: 'Album',
  artUrl: `/art/${id}.jpg`,
});

interface Recorder {
  listener: AudioEngineListener;
  skipped: { direction: string; trackId?: string }[];
  errors: EngineError[];
  plays: number;
  pauses: number;
  ended: number;
}

function recorder(): Recorder {
  const rec: Recorder = {
    listener: {} as AudioEngineListener,
    skipped: [],
    errors: [],
    plays: 0,
    pauses: 0,
    ended: 0,
  };
  rec.listener = {
    onPlaying: () => {
      rec.plays++;
    },
    onPaused: () => {
      rec.pauses++;
    },
    onTime: () => undefined,
    onDuration: () => undefined,
    onEnded: () => {
      rec.ended++;
    },
    onError: (error) => rec.errors.push(error),
    onSkipped: (direction, trackId) =>
      rec.skipped.push({ direction, trackId }),
  };
  return rec;
}

function setup(): {
  plugin: FakePlaylistPlugin;
  engine: NativeAudioEngine;
  rec: Recorder;
} {
  const plugin = new FakePlaylistPlugin();
  const engine = new NativeAudioEngine(
    plugin as never,
    'android',
    async () => undefined,
  );
  const rec = recorder();
  engine.setListener(rec.listener);
  return { plugin, engine, rec };
}

function setCalls(plugin: FakePlaylistPlugin): FakeCall[] {
  return plugin.calls.filter((call) => call.method === 'setPlaylistItems');
}

describe('NativeAudioEngine native window', () => {
  it('sends [current, next] first and inserts previous at index 0', async () => {
    const { plugin, engine } = setup();

    await engine.load(media('b'), {
      previous: media('a'),
      next: media('c'),
    });

    expect(plugin.windows).toEqual([['b', 'c']]);
    expect(plugin.added).toEqual([{ id: 'a', index: 0 }]);
    expect(setCalls(plugin)).toHaveLength(1);
    expect(setCalls(plugin)[0].options?.options).toEqual({
      retainPosition: true,
      playFromId: 'b',
      playFromPosition: 0,
      startPaused: true,
    });
    // The buggy ordering: previous would become native index 0.
    expect(plugin.windows[0]).not.toEqual(['a', 'b', 'c']);
  });

  it('keeps transport state on a same-media window refresh', async () => {
    const { plugin, engine } = setup();

    await engine.load(media('b'), { next: media('c') });
    await engine.load(media('b'), { next: media('d') });
    let last = setCalls(plugin).at(-1);
    expect(last?.options?.options).toEqual({
      retainPosition: true,
      playFromId: 'b',
      startPaused: true,
    });
    expect(last?.options?.options).not.toHaveProperty('playFromPosition');

    await engine.play();
    await engine.load(media('b'), { next: media('e') });
    last = setCalls(plugin).at(-1);
    expect(last?.options?.options).toEqual({
      retainPosition: true,
      playFromId: 'b',
      startPaused: false,
    });
  });

  it('returns early when the same media and window are unchanged', async () => {
    const { plugin, engine } = setup();
    const neighbours = { previous: media('a'), next: media('c') };

    await engine.load(media('b'), neighbours);
    await engine.load(media('b'), neighbours);

    expect(setCalls(plugin)).toHaveLength(1);
    expect(plugin.added).toEqual([{ id: 'a', index: 0 }]);
  });

  it('ignores a previous TRACK_CHANGED while a load is in flight', async () => {
    const { plugin, engine, rec } = setup();
    let release!: () => void;
    plugin.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const loading = engine.load(media('b'), {
      previous: media('a'),
      next: media('c'),
    });
    await vi.waitFor(() => {
      expect(setCalls(plugin)).toHaveLength(1);
    });

    plugin.trackChanged('a');
    expect(rec.skipped).toEqual([]);

    release();
    await loading;
    expect(rec.skipped).toEqual([]);
  });

  it('reports a neighbour TRACK_CHANGED once the load completes', async () => {
    const { plugin, engine, rec } = setup();
    await engine.load(media('b'), { next: media('c') });

    plugin.trackChanged('c');

    expect(rec.skipped).toEqual([{ direction: 'next', trackId: 'c' }]);
  });

  it('refreshes the window in place after a native auto-advance', async () => {
    const { plugin, engine } = setup();
    await engine.load(media('b'), { next: media('c') });
    plugin.trackChanged('c');

    await engine.load(media('c'), {
      previous: media('b'),
      next: media('d'),
    });

    // The native player already started `c`; do not restart it at position 0.
    const last = setCalls(plugin).at(-1);
    expect(last?.options?.options).toEqual({
      retainPosition: true,
      playFromId: 'c',
      startPaused: true,
    });
    expect(last?.options?.options).not.toHaveProperty('playFromPosition');
  });

  it('clears on error, reports once, and suppresses the plugin auto-skip', async () => {
    const { plugin, engine, rec } = setup();
    await engine.load(media('b'), {
      previous: media('a'),
      next: media('c'),
    });

    plugin.error('b', 2, 'Media3 raw network diagnostic');
    await vi.waitFor(() => {
      expect(
        plugin.calls.some((call) => call.method === 'clearAllItems'),
      ).toBe(true);
    });

    expect(rec.errors).toEqual([
      {
        code: 'network',
        message: 'Could not reach the audio source. Check your connection.',
      },
    ]);
    expect(plugin.calls.some((call) => call.method === 'pause')).toBe(true);

    // The plugin's skipFailedItem advances to the next window item.
    plugin.trackChanged('c');
    expect(rec.skipped).toEqual([]);

    // A repeated error for the same item is not reported again.
    plugin.error('b', 2, 'Media3 raw network diagnostic');
    expect(rec.errors).toHaveLength(1);

    // Retry forces a fresh start at position 0, never the retain path.
    await engine.load(media('b'), {
      previous: media('a'),
      next: media('c'),
    });
    const retry = setCalls(plugin).at(-1);
    expect(retry?.options?.options).toEqual({
      retainPosition: true,
      playFromId: 'b',
      playFromPosition: 0,
      startPaused: true,
    });

    // After a successful retry, neighbour skips are live again.
    plugin.trackChanged('c');
    expect(rec.skipped).toEqual([{ direction: 'next', trackId: 'c' }]);
  });

  it('maps known native error codes to friendly copy', async () => {
    const cases: [number, string][] = [
      [1, 'aborted'],
      [2, 'network'],
      [3, 'decode'],
      [4, 'unsupported'],
    ];
    for (const [code, expected] of cases) {
      const { plugin, engine, rec } = setup();
      await engine.load(media('x'));

      plugin.error('x', code, 'raw Media3 diagnostic');
      expect(rec.errors).toHaveLength(1);
      expect(rec.errors[0].code).toBe(expected);
      expect(rec.errors[0].message).not.toContain('raw Media3');
    }
  });

  it('serializes concurrent loads so the latest window wins', async () => {
    const { plugin, engine } = setup();

    const first = engine.load(media('a'), { next: media('b') });
    const second = engine.load(media('c'), { next: media('d') });
    await Promise.all([first, second]);

    expect(plugin.windows.at(-1)).toEqual(['c', 'd']);
    expect(setCalls(plugin).at(-1)?.options?.options?.['playFromId']).toBe(
      'c',
    );
  });

  it('resets transport and failure state on stop', async () => {
    const { plugin, engine } = setup();
    await engine.load(media('b'), { next: media('c') });
    await engine.play();

    await engine.stop();
    expect(plugin.calls.some((call) => call.method === 'clearAllItems')).toBe(
      true,
    );

    // Loading again must take the fresh-start path, not the retain path.
    await engine.load(media('b'), { next: media('c') });
    expect(setCalls(plugin).at(-1)?.options?.options).toEqual({
      retainPosition: true,
      playFromId: 'b',
      playFromPosition: 0,
      startPaused: true,
    });
  });
});
