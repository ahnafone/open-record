import type { PlayableSource, Track } from '@open-record/models';
import { createNeighbourResolver } from './neighbour-resolver';

const REMOTE = 'remote';
const unsaved: Track = { id: 'remote-x', providerId: REMOTE, title: 'x', artist: '' } as Track;
const local: Track = { id: 'local-y', providerId: 'local', title: 'y', artist: '' } as Track;
const streamed: PlayableSource = { url: 'https://stream.example/x', kind: 'remote' };

function setup(native: boolean) {
  const calls: string[] = [];
  const resolve = async (t: Track) => {
    calls.push(`resolve:${t.id}`);
    return streamed;
  };
  const resolveSaved = async (id: string) => {
    calls.push(`saved:${id}`);
    return undefined;
  };
  const neighbour = createNeighbourResolver({
    native,
    remoteProviderId: REMOTE,
    resolve,
    resolveSaved,
  });
  return { neighbour, calls };
}

describe('createNeighbourResolver', () => {
  it('web: resolves unsaved remote neighbours through the normal resolve path', async () => {
    const { neighbour, calls } = setup(false);

    await expect(neighbour(unsaved)).resolves.toEqual(streamed);
    expect(calls).toEqual(['resolve:remote-x']);
  });

  it('native: leaves unsaved remote neighbours out (no stream request)', async () => {
    const { neighbour, calls } = setup(true);

    await expect(neighbour(unsaved)).resolves.toBeUndefined();
    expect(calls).toEqual(['saved:remote-x']);
  });

  it('resolves other providers the same way on both platforms', async () => {
    for (const native of [true, false]) {
      const { neighbour, calls } = setup(native);
      await neighbour(local);
      expect(calls).toEqual(['resolve:local-y']);
    }
  });
});
