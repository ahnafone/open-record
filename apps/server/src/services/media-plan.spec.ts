import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionTrack } from '@open-record/models';
import { catalogAudioPath, planFor } from './media-plan';

function track(overrides: Partial<SessionTrack> = {}): SessionTrack {
  return {
    entryId: 'entry-1',
    id: 'track-1',
    providerId: 'catalog',
    title: 'Song',
    artist: 'Artist',
    ...overrides,
  };
}

const unavailable = { kind: 'unavailable', reason: 'no-source' } as const;

describe('planFor', () => {
  let webDir: string;

  beforeEach(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'open-record-media-plan-'));
    await mkdir(join(webDir, 'catalog', 'audio'), { recursive: true });
  });

  afterEach(async () => {
    await rm(webDir, { recursive: true, force: true });
  });

  it('plans an upload before local, catalog and remote sources', async () => {
    await expect(
      planFor(
        track({
          uploadId: 'upload-1',
          local: true,
          catalogFile: 'song.mp3',
          source: { site: 'youtube', url: 'https://1.1.1.1/watch?v=abc' },
        }),
        { webDir },
      ),
    ).resolves.toEqual({ kind: 'upload', uploadId: 'upload-1' });
  });

  it('does not treat a blank upload id as an upload', async () => {
    await expect(planFor(track({ uploadId: '   ', local: true }))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'local-on-device',
    });
  });

  it('marks a local-only entry as local-on-device', async () => {
    await expect(planFor(track({ local: true, catalogFile: 'song.mp3' }), { webDir })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'local-on-device',
    });
  });

  it('plans a catalog file that exists under <webDir>/catalog/audio', async () => {
    await writeFile(join(webDir, 'catalog', 'audio', 'song.mp3'), 'audio');
    await expect(planFor(track({ catalogFile: 'song.mp3' }), { webDir })).resolves.toEqual({
      kind: 'catalog',
      file: 'song.mp3',
    });
    expect(catalogAudioPath(webDir, 'song.mp3')).toBe(join(webDir, 'catalog', 'audio', 'song.mp3'));
  });

  it('skips the existence check when webDir is null, but still validates the basename', async () => {
    await expect(planFor(track({ catalogFile: 'song.mp3' }), { webDir: null })).resolves.toEqual({
      kind: 'catalog',
      file: 'song.mp3',
    });
    await expect(planFor(track({ catalogFile: 'song.mp3' }), {})).resolves.toEqual({
      kind: 'catalog',
      file: 'song.mp3',
    });
    await expect(planFor(track({ catalogFile: '../song.mp3' }), { webDir: null })).resolves.toEqual(
      unavailable,
    );
  });

  it.each([
    '../secret.mp3',
    'sub/song.mp3',
    '/etc/passwd.mp3',
    '..\\secret.mp3',
    'song.exe',
    '.mp3',
  ])('rejects a catalog value that is not a plain audio basename (%s)', async (catalogFile) => {
    await expect(planFor(track({ catalogFile }), { webDir })).resolves.toEqual(unavailable);
    await expect(planFor(track({ catalogFile }), { webDir: null })).resolves.toEqual(unavailable);
  });

  it('rejects a catalog file that does not exist', async () => {
    await expect(planFor(track({ catalogFile: 'missing.mp3' }), { webDir })).resolves.toEqual(
      unavailable,
    );
  });

  it('rejects a directory whose name looks like an audio file', async () => {
    await mkdir(join(webDir, 'catalog', 'audio', 'song.mp3'));
    await expect(planFor(track({ catalogFile: 'song.mp3' }), { webDir })).resolves.toEqual(
      unavailable,
    );
  });

  it('plans a remote page only after the SSRF guard accepts it', async () => {
    // A literal public IP keeps the spec off DNS; validation still normalises.
    await expect(
      planFor(track({ source: { site: 'youtube', url: 'https://1.1.1.1' } })),
    ).resolves.toEqual({ kind: 'remote', pageUrl: 'https://1.1.1.1/' });
  });

  it.each([
    'http://127.0.0.1/latest/meta-data',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/track',
    'http://192.168.1.1/track',
    'http://localhost:8787/health',
    'http://[::1]/',
    'file:///etc/passwd',
    'https://user:pw@example.com/track',
  ])('rejects a source URL the SSRF guard blocks (%s)', async (url) => {
    await expect(planFor(track({ source: { site: 'youtube', url } }))).resolves.toEqual(unavailable);
  });

  it('returns no-source when the entry has no usable source', async () => {
    await expect(planFor(track())).resolves.toEqual(unavailable);
    await expect(planFor(track({ source: { site: 'youtube', url: '' } }))).resolves.toEqual(
      unavailable,
    );
  });
});
