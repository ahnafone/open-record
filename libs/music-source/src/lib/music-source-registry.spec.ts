import type { PlayableSource, Track } from '@open-record/models';
import type { MusicSourceProvider } from './music-source-provider';
import { MusicSourceRegistry } from './music-source-registry';

function fakeProvider(id: string): MusicSourceProvider {
  return {
    id,
    capabilities: { search: true, download: false },
    search: async () => [],
    resolve: async (trackId: string): Promise<PlayableSource> => ({
      url: `${id}/${trackId}`,
      kind: 'bundled',
    }),
  };
}

describe('MusicSourceRegistry.resolve', () => {
  it('routes a track to the provider named by its providerId', async () => {
    const registry = new MusicSourceRegistry();
    registry.register(fakeProvider('a'));
    registry.register(fakeProvider('b'));

    const track: Track = { id: 'b:1', providerId: 'b', title: 't', artist: 'x' };
    await expect(registry.resolve(track)).resolves.toEqual({ url: 'b/b:1', kind: 'bundled' });
  });

  it('rejects when no provider owns the track', async () => {
    const registry = new MusicSourceRegistry();
    registry.register(fakeProvider('a'));

    await expect(registry.resolve({ id: 'z:1', providerId: 'z' })).rejects.toThrow(/"z"/);
  });
});
