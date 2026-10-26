import type { Track } from '@open-record/models';
import {
  contentHash,
  mergeRecords,
  stampLocal,
  toSyncTrack,
  type Clocked,
} from './sync-merge';

type Rec = Clocked & { id: string; v?: string };
const map = (...recs: Rec[]) => new Map(recs.map((r) => [r.id, r]));
const same = (a: Rec, b: Rec) => a.v === b.v && !a.deletedAt === !b.deletedAt;

describe('account sync merge', () => {
  it('last write wins per record; tombstones delete only what the other side has', () => {
    const local = map(
      { id: 'a', v: 'mine', updatedAt: 20 },
      { id: 'b', v: 'mine', updatedAt: 10 },
      { id: 'c', updatedAt: 30, deletedAt: 30 },
      { id: 'd', v: 'new', updatedAt: 5 },
      { id: 'e', updatedAt: 9, deletedAt: 9 },
    );
    const remote = map(
      { id: 'a', v: 'theirs', updatedAt: 10 },
      { id: 'b', v: 'theirs', updatedAt: 20 },
      { id: 'c', v: 'theirs', updatedAt: 25 },
      { id: 'f', v: 'cloud', updatedAt: 1 },
      { id: 'g', updatedAt: 2, deletedAt: 2 },
    );
    const { push, apply } = mergeRecords(local, remote, same);
    expect(push.map((r) => r.id).sort()).toEqual(['a', 'c', 'd']);
    expect(apply.map((r) => r.id).sort()).toEqual(['b', 'f']);
  });

  it('stamps local changes and deletions against the ledger', () => {
    const content = new Map([
      ['same', { x: 1 }],
      ['edited', { x: 2 }],
      ['fresh', { x: 3 }],
    ]);
    const ledger = {
      same: { h: contentHash({ x: 1 }), u: 100 },
      edited: { h: contentHash({ x: 1 }), u: 100 },
      gone: { h: contentHash({ x: 9 }), u: 100 },
    };
    const out = stampLocal(content, ledger, 500, { firstSync: false });
    expect(out.get('same')?.updatedAt).toBe(100);
    expect(out.get('edited')?.updatedAt).toBe(500);
    expect(out.get('fresh')?.updatedAt).toBe(500);
    expect(out.get('gone')).toEqual({ updatedAt: 500, deletedAt: 500 });
    // On an account's first sync, unknown local records lose ties to the cloud.
    expect(stampLocal(content, {}, 500, { firstSync: true }).get('fresh')?.updatedAt).toBe(0);
  });

  it('syncs metadata only: never device paths or local file URLs', () => {
    const track: Track = {
      id: 'remote:abc',
      providerId: 'remote',
      title: 'Song',
      artist: 'Artist',
      artUrl: 'blob:http://localhost/123',
      sourceFile: '/data/user/0/audio/abc.m4a',
      coverPath: 'covers/abc.jpg',
      external: { spotifyId: 'sp1' },
      source: { site: 'youtube', url: 'https://youtu.be/abc' },
    } as Track;
    const synced = toSyncTrack(track) as unknown as Record<string, unknown>;
    expect(synced['sourceFile']).toBeUndefined();
    expect(synced['coverPath']).toBeUndefined();
    expect(synced['artUrl']).toBeUndefined();
    expect(synced['spotifyId']).toBe('sp1');
    expect(synced['sourceUrl']).toBe('https://youtu.be/abc');
  });
});
