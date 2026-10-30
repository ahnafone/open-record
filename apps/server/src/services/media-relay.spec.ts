import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaPlan } from './media-plan';
import {
  CAST_SECRET_FILE_NAME,
  loadOrCreateCastSecret,
  MAX_RELAY_TTL_MS,
  MediaRelay,
  type MediaRelayOptions,
} from './media-relay';

const START = Date.parse('2026-01-01T00:00:00Z');
const TTL = 60_000;

let now = START;
let relays: MediaRelay[] = [];

function makeRelay(overrides: Partial<MediaRelayOptions> = {}): MediaRelay {
  return new MediaRelay({
    secret: Buffer.alloc(32, 7),
    dataDir: join(tmpdir(), 'open-record-relay-unused'),
    baseUrl: 'http://10.0.0.5:8787',
    ttlMs: TTL,
    now: () => now,
    pruneMs: 0,
    ...overrides,
  });
}

function relay(overrides: Partial<MediaRelayOptions> = {}): MediaRelay {
  const instance = makeRelay(overrides);
  relays.push(instance);
  return instance;
}

const catalogPlan: MediaPlan = { kind: 'catalog', file: 'song.mp3' };

function create(
  instance: MediaRelay,
  params: { userId?: string; trackId?: string; plan?: MediaPlan } = {},
): { id: string; url: string; expiresAt: number } {
  return instance.create({
    userId: params.userId ?? 'user-1',
    trackId: params.trackId ?? 'track-1',
    plan: params.plan ?? catalogPlan,
  });
}

function tokenOf(url: string): string {
  const path = new URL(url).pathname;
  return path.slice(path.lastIndexOf('/') + 1);
}

beforeEach(() => {
  now = START;
});

afterEach(() => {
  for (const instance of relays) instance.dispose();
  relays = [];
  vi.useRealTimers();
});

describe('MediaRelay tokens', () => {
  it('mints a URL that verifies back to its entry', () => {
    const instance = relay();
    const made = create(instance, { plan: { kind: 'upload', uploadId: 'up-1' } });
    const token = tokenOf(made.url);

    expect(made.expiresAt).toBe(START + TTL);
    expect(made.url.startsWith('http://10.0.0.5:8787/cast/relay/')).toBe(true);
    expect(token.split('.')).toHaveLength(2);
    expect(instance.verify(token)).toMatchObject({
      id: made.id,
      userId: 'user-1',
      trackId: 'track-1',
      plan: { kind: 'upload', uploadId: 'up-1' },
    });
  });

  it('builds URLs without a doubled slash when baseUrl ends in one', () => {
    const made = create(relay({ baseUrl: 'http://10.0.0.5:8787///' }));
    expect(made.url.startsWith('http://10.0.0.5:8787/cast/relay/')).toBe(true);
    expect(made.url).not.toContain('//cast');
  });

  it('rejects tampered, swapped, malformed and unknown tokens', () => {
    const instance = relay();
    const first = tokenOf(create(instance).url);
    const second = create(instance, { trackId: 'track-2' });
    const [idPart, signaturePart] = first.split('.');

    const flipped = `${signaturePart[0] === 'A' ? 'B' : 'A'}${signaturePart.slice(1)}`;
    expect(instance.verify(`${idPart}.${flipped}`)).toBeNull();
    expect(instance.verify(`${idPart}.${tokenOf(second.url).split('.')[1]}`)).toBeNull();
    expect(instance.verify(tokenOf(second.url))).not.toBeNull();
    expect(instance.verify('')).toBeNull();
    expect(instance.verify('one-part')).toBeNull();
    expect(instance.verify(`${first}.extra`)).toBeNull();
    expect(instance.verify(`x${idPart}.${signaturePart}`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const instance = relay();
    const token = tokenOf(create(instance).url);
    expect(instance.verify(token)).not.toBeNull();

    now = START + TTL;
    expect(instance.verify(token)).toBeNull();
  });
});

describe('MediaRelay lifetime', () => {
  it('slides the TTL on touch', () => {
    const instance = relay();
    const made = create(instance);
    const token = tokenOf(made.url);

    now = START + 30_000;
    expect(instance.touch(made.id)).toBe(true);
    now = START + TTL;
    expect(instance.verify(token)).not.toBeNull();
    now = START + TTL + 30_000;
    expect(instance.verify(token)).toBeNull();
  });

  it('caps the sliding TTL at 24 hours from creation', () => {
    const instance = relay({ ttlMs: MAX_RELAY_TTL_MS });
    const made = create(instance);
    const token = tokenOf(made.url);

    now = START + MAX_RELAY_TTL_MS - 60_000;
    expect(instance.touch(made.id)).toBe(true);
    expect(instance.verify(token)?.expiresAt).toBe(START + MAX_RELAY_TTL_MS);

    now = START + MAX_RELAY_TTL_MS;
    expect(instance.verify(token)).toBeNull();
    expect(instance.touch(made.id)).toBe(false);
  });

  it('returns false when touching an unknown entry', () => {
    expect(relay().touch('nope')).toBe(false);
  });

  it('prunes expired entries only', () => {
    const instance = relay();
    const first = create(instance);
    now = START + 30_000;
    const second = create(instance);

    now = START + TTL;
    instance.prune(now);
    now = START; // rewind: a surviving entry verifies again, a pruned one cannot
    expect(instance.verify(tokenOf(first.url))).toBeNull();
    expect(instance.verify(tokenOf(second.url))).not.toBeNull();
  });

  it('prunes on its own interval, and dispose stops it', () => {
    vi.useFakeTimers();
    const instance = relay({ pruneMs: 1000 });
    const made = create(instance);

    now = START + TTL + 1;
    vi.advanceTimersByTime(1000);
    now = START;
    expect(instance.verify(tokenOf(made.url))).toBeNull();

    instance.dispose();
    const late = create(instance);
    now = START + TTL + 1;
    vi.advanceTimersByTime(5000);
    now = START;
    expect(instance.verify(tokenOf(late.url))).not.toBeNull();
  });

  it('stores and replaces the resolved link', () => {
    const instance = relay();
    const made = create(instance);
    const resolved = {
      url: 'https://1.1.1.1/media.m4a',
      mimeType: 'audio/mp4',
      headers: { 'user-agent': 'test' },
      expiresAt: START + 5_000,
    };

    instance.setResolved(made.id, resolved);
    expect(instance.verify(tokenOf(made.url))?.resolved).toEqual(resolved);
    instance.setResolved('missing', resolved); // unknown id is a no-op
  });

  it('records how an entry is being streamed', () => {
    const instance = relay();
    const made = create(instance);

    expect(instance.streamInfo(made.id)).toBeUndefined();
    instance.setStream(made.id, { transcoded: true, offsetSec: 42 });
    expect(instance.streamInfo(made.id)).toEqual({ transcoded: true, offsetSec: 42 });
    expect(instance.verify(tokenOf(made.url))?.stream).toEqual({
      transcoded: true,
      offsetSec: 42,
    });

    instance.setStream('missing', { transcoded: true, offsetSec: 0 }); // unknown id is a no-op
    expect(instance.streamInfo('missing')).toBeUndefined();
  });
});

describe('MediaRelay liveUploads', () => {
  it('lists upload ids of live entries, scoped by user', () => {
    const instance = relay();
    create(instance, { plan: { kind: 'upload', uploadId: 'up-1' } });
    create(instance, { plan: { kind: 'upload', uploadId: 'up-2' }, userId: 'user-2' });
    create(instance);

    expect([...instance.liveUploads()].sort()).toEqual(['up-1', 'up-2']);
    expect([...instance.liveUploads('user-1')]).toEqual(['up-1']);
    expect([...instance.liveUploads('user-2')]).toEqual(['up-2']);

    now = START + TTL;
    expect(instance.liveUploads().size).toBe(0);
  });
});

describe('cast secret', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'open-record-cast-secret-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates a 32-byte secret with mode 0600 and reuses it', () => {
    const path = join(dataDir, CAST_SECRET_FILE_NAME);
    const first = loadOrCreateCastSecret(dataDir);

    expect(first).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path).equals(first)).toBe(true);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const second = loadOrCreateCastSecret(dataDir);
    expect(second.equals(first)).toBe(true);
  });

  it('creates the data directory recursively', () => {
    const nested = join(dataDir, 'nested', 'data');
    const secret = loadOrCreateCastSecret(nested);
    expect(secret).toHaveLength(32);
    expect(statSync(join(nested, CAST_SECRET_FILE_NAME)).mode & 0o777).toBe(0o600);
  });

  it('rejects a corrupt secret file instead of silently regenerating it', () => {
    writeFileSync(join(dataDir, CAST_SECRET_FILE_NAME), 'short');
    expect(() => loadOrCreateCastSecret(dataDir)).toThrow(/32 bytes/);
  });
});
