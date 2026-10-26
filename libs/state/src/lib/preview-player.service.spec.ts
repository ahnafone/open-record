import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import type { AudioEngine, AudioEngineListener } from '@open-record/player';
import { PlayerStore } from './player.store';
import { PREVIEW_AUDIO_ENGINE, PreviewPlayerService } from './preview-player.service';

const a: Track = { id: 'fake:a', providerId: 'fake', title: 'A', artist: 'X' };
const b: Track = { id: 'fake:b', providerId: 'fake', title: 'B', artist: 'Y' };

function fakeEngine() {
  let listener: AudioEngineListener | null = null;
  const log: string[] = [];
  const engine: AudioEngine = {
    ownsSystemControls: false,
    wantsNeighbours: false,
    setListener: (l) => (listener = l),
    load: async (m) => void log.push(`load ${m.source.url}`),
    play: async () => listener?.onPlaying(),
    pause: async () => listener?.onPaused(),
    seek: async () => undefined,
    stop: async () => void log.push('stop'),
    destroy: async () => undefined,
  };
  return { engine, log };
}

describe('PreviewPlayerService', () => {
  it('plays one preview at a time and stop() clears it, without touching the main player', async () => {
    const registry = new MusicSourceRegistry();
    registry.register({
      id: 'fake',
      capabilities: { search: false, download: false },
      list: async () => [],
      search: async () => [],
      resolve: async (id) => ({ url: id, kind: 'remote' }),
    });
    const { engine, log } = fakeEngine();
    const mainPause = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: MusicSourceRegistry, useValue: registry },
        { provide: PREVIEW_AUDIO_ENGINE, useValue: () => engine },
        { provide: PlayerStore, useValue: { isPlaying: signal(false), pause: mainPause } },
      ],
    });
    const preview = TestBed.inject(PreviewPlayerService);

    await preview.toggle(a);
    expect(preview.playingId()).toBe('fake:a');
    await preview.toggle(b);
    expect(preview.playingId()).toBe('fake:b');
    expect(log).toEqual(['load fake:a', 'stop', 'load fake:b']);

    await preview.stop();
    expect(preview.playingId()).toBeNull();
    expect(log.at(-1)).toBe('stop');
    expect(mainPause).not.toHaveBeenCalled();
  });
});
