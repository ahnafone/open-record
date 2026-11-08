import type { EngineMedia } from './audio-engine';
import { Html5AudioEngine } from './html5-audio-engine';

/** Just enough of HTMLAudioElement for the engine's spare-element logic. */
class FakeAudio {
  src = '';
  preload = '';
  volume = 1;
  currentTime = 0;
  duration = Number.NaN;
  ended = false;
  error: MediaError | null = null;
  plays = 0;
  loads = 0;

  addEventListener(): void {
    /* events are not dispatched in these tests */
  }
  removeEventListener(): void {
    /* noop */
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
    /* noop */
  }
  async play(): Promise<void> {
    this.plays++;
  }
}

const media = (id: string): EngineMedia => ({
  id,
  source: { kind: 'bundled', url: `/${id}.mp3` },
  title: id,
  artist: 'Artist',
});

function setup() {
  const active = new FakeAudio();
  const created: FakeAudio[] = [];
  const engine = new Html5AudioEngine(
    active as unknown as HTMLAudioElement,
    () => {
      const audio = new FakeAudio();
      created.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
  );
  return { engine, active, created };
}

describe('Html5AudioEngine spares', () => {
  it('reuses the warm element for both the next and the previous load', async () => {
    const { engine, active, created } = setup();
    await engine.load(media('b'));
    engine.preload({ previous: media('a'), next: media('c') });
    expect(created.map((a) => a.src)).toEqual(['/a.mp3', '/c.mp3']);

    // Skip forward: the next spare becomes the active element.
    await engine.load(media('c'));
    await engine.play();
    expect(created[1].plays).toBe(1);
    expect(active.plays).toBe(0);

    // The previous spare stayed warm, so going back adopts it too.
    expect(created[0].src).toBe('/a.mp3');
    await engine.load(media('a'));
    await engine.play();
    expect(created[0].plays).toBe(1);
    expect(created).toHaveLength(2);
  });

  it('skip next then back reuses the original element without reloading it', async () => {
    const { engine, active } = setup();
    await engine.load(media('b'));
    engine.preload({ previous: media('a'), next: media('c') });
    const loadsBefore = active.loads;

    await engine.load(media('c'));
    engine.preload({ previous: media('b'), next: media('d') });
    await engine.load(media('b'));
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
    await engine.load(media('b'));
    engine.preload({ previous: media('a'), next: media('c') });

    engine.preload({ next: media('c'), previous: media('b') });
    // `a` left the window (released); `b` is loaded, so it gets no spare.
    expect(created[0].src).toBe('');
    expect(created.map((a) => a.src)).toEqual(['', '/c.mp3']);
  });

  it('releases every spare and the parked element on stop', async () => {
    const { engine, active, created } = setup();
    await engine.load(media('b'));
    engine.preload({ previous: media('a'), next: media('c') });
    await engine.load(media('c'));

    await engine.stop();
    expect(active.src).toBe('');
    expect(created.map((a) => a.src)).toEqual(['', '']);
  });

  it('a non-spare load reuses the original element and creates none', async () => {
    const { engine, active, created } = setup();
    await engine.load(media('b'));
    engine.preload({ previous: media('a'), next: media('c') });
    created.length = 0; // only count elements created by the next load

    // `z` is not a neighbour: no spare hit, so the active element is reused.
    await engine.load(media('z'));
    await engine.play();
    expect(created).toHaveLength(0);
    expect(active.src).toBe('/z.mp3');
    expect(active.loads).toBe(2);
    expect(active.plays).toBe(1);
  });

  it('does not adopt a spare whose element errored, and rebuffers it on preload', async () => {
    const { engine, active, created } = setup();
    await engine.load(media('b'));
    engine.preload({ previous: media('a'), next: media('c') });
    created[1].error = { code: 2, message: 'net' } as unknown as MediaError;

    await engine.load(media('c'));
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
