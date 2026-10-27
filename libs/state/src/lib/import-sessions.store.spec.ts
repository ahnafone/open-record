import { TestBed } from '@angular/core/testing';
import { MusicSourceRegistry } from '@open-record/music-source';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { ImportSessionsStore, importSessionCounts } from './import-sessions.store';
import { ImportStore } from './import.store';
import { AuthStore } from './auth.store';
import { AuthPort, SyncPort, type SyncImportSession, type SyncSnapshot } from './ports';
import { SyncStore } from './sync.store';

describe('import sessions', () => {
  it('records sessions newest first and drops Spotify ones when Spotify data is deleted', async () => {
    const storage = createInMemoryStorage();
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: storage },
        { provide: MusicSourceRegistry, useValue: new MusicSourceRegistry() },
      ],
    });
    const sessions = TestBed.inject(ImportSessionsStore);
    const imports = TestBed.inject(ImportStore);

    const files = await sessions.record({ kind: 'files', added: 2, skipped: 0, failed: 1, trackIds: ['a', 'b'] });
    expect(files.label).toMatch(/^Audio files · /);
    await new Promise((r) => setTimeout(r, 5));
    const song = { title: 'Midnight City', artists: ['M83'], artist: 'M83', spotifyId: '4uLU6hMCjMI75M1A2tKUQC' };
    await imports.start({ playlists: [{ name: 'Drive', tracks: [song] }], liked: [] }, { label: 'Drive.csv' });

    const listed = await storage.importSessions.list();
    expect(listed.map((s) => s.label)).toEqual(['Spotify · Drive.csv', files.label]);
    expect(listed[0]).toMatchObject({ added: 1, trackIds: ['spotify:4uLU6hMCjMI75M1A2tKUQC'] });
    expect(importSessionCounts(listed[0], (k) => imports.itemStates().get(k))).toBe('1 track · 1 matching');

    await imports.deleteImportData();
    expect((await storage.importSessions.list()).map((s) => s.kind)).toEqual(['files']);
    expect(sessions.sessions().map((s) => s.kind)).toEqual(['files']);
  });
});

describe('import sessions account sync', () => {
  it('shares sessions with the account and propagates deletions as tombstones', async () => {
    const cloud = new Map<string, SyncImportSession>();
    const port = {
      userId: async () => 'u1',
      pull: async (): Promise<SyncSnapshot> => ({ library: [], playlists: [], importSessions: [...cloud.values()] }),
      push: async (c: SyncSnapshot) => {
        for (const s of c.importSessions) cloud.set(s.id, { ...s });
      },
    } as SyncPort;
    const auth = {
      activeProject: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon' }),
      restore: async () => ({ id: 'u1', email: 'me@example.com' }),
      onChange: () => () => undefined,
      onRecovery: () => () => undefined,
    } as unknown as AuthPort;
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: createInMemoryStorage() },
        { provide: MusicSourceRegistry, useValue: new MusicSourceRegistry() },
        { provide: AuthPort, useValue: auth },
        { provide: SyncPort, useValue: port },
      ],
    });
    await TestBed.inject(AuthStore).start();
    const sessions = TestBed.inject(ImportSessionsStore);
    const sync = TestBed.inject(SyncStore);

    // Another device's session arrives; a local one goes up.
    cloud.set('other', {
      id: 'other', kind: 'spotify', label: 'Spotify · Liked.json', createdAt: 1, added: 3,
      skipped: 0, failed: 0, trackIds: ['spotify:x'], updatedAt: 5,
    });
    const mine = await sessions.record({ kind: 'spotify', added: 1, skipped: 0, failed: 0, trackIds: ['spotify:y'] });
    await sync.syncNow();
    expect(sessions.sessions().map((s) => s.id).sort()).toEqual([mine.id, 'other'].sort());
    expect(cloud.get(mine.id)).toMatchObject({ label: mine.label, trackIds: ['spotify:y'] });

    // Spotify data delete removes them here and from the account.
    await sessions.deleteKind('spotify');
    await sync.syncNow();
    expect(cloud.get(mine.id)?.deletedAt).toBeTruthy();
    expect(cloud.get('other')?.deletedAt).toBeTruthy();
    await sync.syncNow();
    expect(sessions.sessions()).toEqual([]);
  });
});
