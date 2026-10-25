import type { PlayableSource, Track } from '@open-record/models';
import type {
  AudioEngine,
  AudioEngineListener,
  EngineMedia,
} from './audio-engine';
import { PlayerEngine } from './player-engine';

class FakeEngine implements AudioEngine {
  readonly ownsSystemControls = false;
  readonly wantsNeighbours = false;
  listener: AudioEngineListener | null = null;
  loaded: string[] = [];
  seeks: number[] = [];
  failOn = new Set<string>();

  setListener(l: AudioEngineListener | null): void {
    this.listener = l;
  }
  async load(media: EngineMedia): Promise<void> {
    this.loaded.push(media.id);
  }
  async play(): Promise<void> {
    const id = this.loaded.at(-1) ?? '';
    if (this.failOn.has(id)) {
      this.listener?.onError({ code: 'decode', message: 'bad file' });
    } else {
      this.listener?.onPlaying();
    }
  }
  async pause(): Promise<void> {
    this.listener?.onPaused();
  }
  async seek(sec: number): Promise<void> {
    this.seeks.push(sec);
    this.listener?.onTime(sec);
  }
  async stop(): Promise<void> {
    /* noop */
  }
  async destroy(): Promise<void> {
    /* noop */
  }
}

const track = (id: string): Track => ({
  id,
  providerId: 'test',
  title: id,
  artist: 'Artist',
});
const tracks = ['a', 'b', 'c', 'd', 'e'].map(track);
const resolve = async (t: Track): Promise<PlayableSource> => ({
  url: `/${t.id}.mp3`,
  kind: 'bundled',
});

/** Let async error-driven skips settle. */
const flush = () => new Promise<void>((r) => setTimeout(r));

/** Deterministic random source. */
function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

function setup(opts: { skipOnError?: boolean } = {}) {
  const fake = new FakeEngine();
  const player = new PlayerEngine(fake, resolve, { random: seeded(), ...opts });
  const ids = () => player.current()?.id;
  return { fake, player, ids };
}

describe('PlayerEngine', () => {
  it('plays the queue in order and stops at the end with repeat off', async () => {
    const { player, ids, fake } = setup();
    await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
    expect(ids()).toBe('b');
    expect(player.status()).toBe('playing');

    expect(await player.next()).toBe(true);
    expect(ids()).toBe('c');
    expect(await player.next()).toBe(false);

    fake.listener?.onEnded();
    await Promise.resolve();
    expect(player.status()).toBe('ended');
    expect(ids()).toBe('c');
  });

  it('previous restarts after 3s, otherwise goes back', async () => {
    const { player, ids, fake } = setup();
    await player.setQueue(tracks, { startIndex: 2 });

    fake.listener?.onTime(10);
    await player.previous();
    expect(ids()).toBe('c');
    expect(fake.seeks.at(-1)).toBe(0);

    fake.listener?.onTime(1);
    await player.previous();
    expect(ids()).toBe('b');
  });

  it('repeat all wraps both ways; repeat one restarts on track end', async () => {
    const { player, ids, fake } = setup();
    await player.setQueue(tracks.slice(0, 2), { startIndex: 1 });
    player.setRepeat('all');
    await player.next();
    expect(ids()).toBe('a');
    await player.previous();
    expect(ids()).toBe('b');

    player.setRepeat('one');
    const loads = fake.loaded.length;
    fake.listener?.onTime(30);
    fake.listener?.onEnded();
    await Promise.resolve();
    expect(ids()).toBe('b');
    expect(fake.loaded.length).toBe(loads);
    expect(fake.seeks.at(-1)).toBe(0);
  });

  it('shuffle keeps the current track first and a stable order', async () => {
    const { player, ids } = setup();
    await player.setQueue(tracks, { startIndex: 2 });
    player.setShuffle(true);

    expect(ids()).toBe('c');
    const order = player.upcoming().map((t) => t.id);
    expect([...order].sort()).toEqual(['a', 'b', 'd', 'e']);

    // Walking the queue follows the same order it promised.
    const played: string[] = [];
    while (await player.next()) played.push(ids() ?? '');
    expect(played).toEqual(order);

    // Turning shuffle off resumes the original order from the current track.
    player.setShuffle(false);
    expect(player.currentIndex()).toBe(tracks.findIndex((t) => t.id === ids()));
  });

  it('skips failing tracks and exposes the error', async () => {
    const { player, ids, fake } = setup();
    fake.failOn.add('b');
    await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
    await flush();
    expect(ids()).toBe('c');
    expect(player.status()).toBe('playing');
    expect(player.error()).toBeNull();

    const strict = setup({ skipOnError: false });
    strict.fake.failOn.add('a');
    await strict.player.setQueue(tracks.slice(0, 2));
    await flush();
    expect(strict.ids()).toBe('a');
    expect(strict.player.status()).toBe('error');
    expect(strict.player.error()).toMatchObject({
      trackId: 'a',
      code: 'decode',
    });
  });

  it('stops skipping when every track fails', async () => {
    const { player, fake } = setup();
    ['a', 'b', 'c'].forEach((id) => fake.failOn.add(id));
    player.setRepeat('all');
    await player.setQueue(tracks.slice(0, 3));
    await flush();
    expect(player.status()).toBe('error');
    expect(fake.loaded.length).toBe(3);
  });
});
