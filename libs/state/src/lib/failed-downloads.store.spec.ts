import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { FailedDownloadsStore } from './failed-downloads.store';
import { ImportSessionsStore } from './import-sessions.store';
import { ImportStore } from './import.store';
import { LibraryStore } from './library.store';
import { OfflineStore } from './offline.store';
import { PlayerStore } from './player.store';
import { PlaylistsStore } from './playlists.store';

function remoteTrack(id: string, url: string): Track {
  return {
    id,
    providerId: 'remote',
    title: 'Song',
    artist: 'Artist',
    source: { site: 'youtube', url },
  };
}

function setupPlaybackFix() {
  const old = remoteTrack(
    'remote:https%3A%2F%2Fmusic.youtube.com%2Fwatch%3Fv%3Dabcdefghijk',
    'https://music.youtube.com/watch?v=abcdefghijk',
  );
  const candidate = remoteTrack(
    'remote:https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dzyxwvutsrqp',
    'https://www.youtube.com/watch?v=zyxwvutsrqp',
  );
  const library = {
    importedTracks: computed<readonly Track[]>(() => []),
    track: vi.fn(() => old),
    storedRecord: vi.fn(),
    replaceTrackId: vi.fn(async () => undefined),
    ready: vi.fn(async () => undefined),
  };
  const offline = {
    ensureSaved: vi.fn(async () => undefined),
    forget: vi.fn(),
    retry: vi.fn(async () => undefined),
  };
  const playlists = { replaceTrackEverywhere: vi.fn(async () => undefined), ready: vi.fn(async () => undefined) };
  const player = {
    current: signal<Track | null>(old),
    replaceTrack: vi.fn<PlayerStore['replaceTrack']>(async () => true),
  };
  const sessions = { replaceTrackId: vi.fn(async () => undefined) };
  const importer = { replaceMatchId: vi.fn(async () => undefined) };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: LibraryStore, useValue: library },
      { provide: OfflineStore, useValue: offline },
      { provide: PlaylistsStore, useValue: playlists },
      { provide: PlayerStore, useValue: player },
      { provide: ImportSessionsStore, useValue: sessions },
      { provide: ImportStore, useValue: importer },
    ],
  });
  const store = TestBed.inject(FailedDownloadsStore);
  return { store, old, candidate, library, offline, playlists, player, sessions, importer };
}

describe('failed downloads store', () => {
  it('keeps a track listed while its retry is queued and drops it once saved', async () => {
    TestBed.resetTestingModule();
    const track: Track = {
      id: 'remote:retry',
      providerId: 'remote',
      title: 'Song',
      artist: 'Artist',
      source: { site: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    };
    const status = signal<'failed' | 'queued' | 'saving' | 'saved'>('failed');
    const error = signal<string | undefined>('Video unavailable');
    let finish!: () => void;
    const retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStore, useValue: { importedTracks: computed(() => [track]) } },
        {
          provide: OfflineStore,
          useValue: { status: () => status(), error: () => error(), retry },
        },
        { provide: PlaylistsStore, useValue: {} },
        { provide: PlayerStore, useValue: {} },
        { provide: ImportSessionsStore, useValue: {} },
        { provide: ImportStore, useValue: {} },
      ],
    });
    const store = TestBed.inject(FailedDownloadsStore);

    expect(store.tracks()).toEqual([track]);
    expect(store.listed()).toEqual([track]);
    expect(store.isRetrying(track.id)).toBe(false);

    const retried = store.retry(track.id);
    // The record write is still in flight: the row must not drop.
    expect(store.isRetrying(track.id)).toBe(false);
    expect(store.listed()).toEqual([track]);
    expect(store.tracks()).toEqual([track]);

    status.set('queued');
    expect(store.isRetrying(track.id)).toBe(true);
    expect(store.listed()).toEqual([track]);
    expect(store.tracks()).toEqual([]);

    finish();
    await retried;
    status.set('saved');
    expect(store.isRetrying(track.id)).toBe(false);
    expect(store.listed()).toEqual([]);

    status.set('failed');
    error.set('Video unavailable');
    expect(store.listed()).toEqual([track]);
    expect(store.isRetrying(track.id)).toBe(false);
    expect(retry).toHaveBeenCalledWith(track.id);
  });

  it('rejects the same video on another YouTube host before any playback fix write', async () => {
    const { store, old, candidate, player, library, playlists, sessions, importer } = setupPlaybackFix();
    // Same 11-character video id, canonicalised to a different host.
    candidate.source = { site: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk' };

    await expect(store.replaceForPlayback(old.id, candidate)).rejects.toThrow(
      'That’s the same recording. Pick another version or paste a different link.',
    );
    expect(player.replaceTrack).not.toHaveBeenCalled();
    expect(library.replaceTrackId).not.toHaveBeenCalled();
    expect(playlists.replaceTrackEverywhere).not.toHaveBeenCalled();
    expect(sessions.replaceTrackId).not.toHaveBeenCalled();
    expect(importer.replaceMatchId).not.toHaveBeenCalled();
  });

  it('replaceForPlayback swaps the current source and asks the player to start it', async () => {
    const { store, old, candidate, player, library, playlists, sessions, importer, offline } =
      setupPlaybackFix();

    const result = await store.replaceForPlayback(old.id, candidate);

    expect(player.replaceTrack).toHaveBeenCalledWith(
      old.id,
      expect.objectContaining({
        id: candidate.id,
        providerId: candidate.providerId,
        source: candidate.source,
      }),
      { playCurrent: true },
    );
    const swapped = player.replaceTrack.mock.calls[0]?.[1] as Track;
    expect(swapped.sourceFile).toBeUndefined();
    expect(swapped.sizeBytes).toBeUndefined();
    expect(offline.forget).toHaveBeenCalledWith([old.id]);
    expect(library.replaceTrackId).toHaveBeenCalledWith(old.id, expect.objectContaining({ id: candidate.id }));
    expect(playlists.replaceTrackEverywhere).toHaveBeenCalledWith(old.id, candidate.id);
    expect(sessions.replaceTrackId).toHaveBeenCalledWith(old.id, candidate.id);
    expect(importer.replaceMatchId).toHaveBeenCalledWith(old.id, expect.objectContaining({ id: candidate.id }));
    expect(offline.ensureSaved).not.toHaveBeenCalled();
    expect(result).toEqual({ track: expect.objectContaining({ id: candidate.id }), current: true });
  });

  it('does not fail the playback fix when scheduling the replacement save rejects', async () => {
    const { store, old, candidate, library, offline } = setupPlaybackFix();
    library.storedRecord.mockReturnValueOnce({ track: old });
    offline.ensureSaved.mockRejectedValueOnce(new Error('save failed'));

    await expect(store.replaceForPlayback(old.id, candidate)).resolves.toEqual({
      track: expect.objectContaining({ id: candidate.id }),
      current: true,
    });
    expect(offline.ensureSaved).toHaveBeenCalledTimes(1);
  });
});
