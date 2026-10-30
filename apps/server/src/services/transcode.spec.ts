import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  TranscodeUnavailableError,
  adtsArgs,
  createTranscoder,
  ffmpegAvailable,
  isCastFriendlyAudio,
  type SpawnFn,
} from './transcode';

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function fakeSpawn(child: FakeChild): { spawnFn: SpawnFn; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  return { spawnFn: spawn as unknown as SpawnFn, spawn };
}

/** Tiny PCM WAV (silence) that real ffmpeg can probe from a pipe. */
function wavSilence(seconds: number): Buffer {
  const sampleRate = 8_000;
  const samples = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('adtsArgs', () => {
  it('streams piped ADTS and puts an input seek before -i', () => {
    expect(adtsArgs(0)).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-protocol_whitelist',
      'pipe',
      '-i',
      'pipe:0',
      '-vn',
      '-f',
      'adts',
      '-b:a',
      '192k',
      'pipe:1',
    ]);

    const seek = adtsArgs(42.5);
    expect(seek[seek.indexOf('-ss') + 1]).toBe('42.5');
    expect(seek.indexOf('-ss')).toBeLessThan(seek.indexOf('-i'));

    // A nonsense offset must not become an invalid `-ss` argument.
    expect(adtsArgs(-5)).not.toContain('-ss');
    expect(adtsArgs(Number.NaN)).not.toContain('-ss');
  });
});

describe('isCastFriendlyAudio', () => {
  it('accepts the mimes a receiver decodes natively and falls back to ADTS otherwise', () => {
    for (const mime of ['audio/mp4', 'AUDIO/AAC', 'audio/mpeg; charset=binary', ' audio/mp3 ']) {
      expect(isCastFriendlyAudio(mime)).toBe(true);
    }
    for (const mime of [undefined, '', 'audio/webm', 'audio/ogg', 'video/mp4']) {
      expect(isCastFriendlyAudio(mime)).toBe(false);
    }
  });
});

describe('createTranscoder', () => {
  it('spawns ffmpeg with piped stdio and the offset arguments', () => {
    const child = fakeChild();
    const { spawnFn, spawn } = fakeSpawn(child);

    createTranscoder({ ffmpegPath: '/opt/ffmpeg', offsetSec: 30, spawn: spawnFn });

    expect(spawn).toHaveBeenCalledWith('/opt/ffmpeg', adtsArgs(30), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('throws TranscodeUnavailableError when ffmpeg cannot be started synchronously', () => {
    const spawnFn = vi.fn(() => {
      const error = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }) as unknown as SpawnFn;

    expect(() => createTranscoder({ ffmpegPath: 'ffmpeg', offsetSec: 0, spawn: spawnFn })).toThrow(
      TranscodeUnavailableError,
    );
  });

  it('rejects done with TranscodeUnavailableError on an asynchronous ENOENT', async () => {
    const child = fakeChild();
    const transcoder = createTranscoder({
      ffmpegPath: 'ffmpeg',
      offsetSec: 0,
      spawn: fakeSpawn(child).spawnFn,
    });

    const error = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    child.emit('error', error);

    await expect(transcoder.done).rejects.toBeInstanceOf(TranscodeUnavailableError);
  });

  it('resolves on exit code 0 and rejects with a capped stderr tail otherwise', async () => {
    const okChild = fakeChild();
    const ok = createTranscoder({
      ffmpegPath: 'ffmpeg',
      offsetSec: 0,
      spawn: fakeSpawn(okChild).spawnFn,
    });
    okChild.emit('close', 0, null);
    await expect(ok.done).resolves.toBeUndefined();

    const child = fakeChild();
    const failed = createTranscoder({
      ffmpegPath: 'ffmpeg',
      offsetSec: 0,
      spawn: fakeSpawn(child).spawnFn,
    });
    child.stderr.write(`START${'x'.repeat(2000)}END`);
    child.emit('close', 1, null);

    const error = await failed.done.catch((reason: Error) => reason);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('END');
    expect(message).not.toContain('START');
    expect(message.startsWith('ffmpeg exited with code 1:')).toBe(true);
    expect(message.length).toBeLessThan(600);
  });

  it('kills idempotently', () => {
    const child = fakeChild();
    const transcoder = createTranscoder({
      ffmpegPath: 'ffmpeg',
      offsetSec: 0,
      spawn: fakeSpawn(child).spawnFn,
    });

    transcoder.kill();
    transcoder.kill();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.stdin.destroyed).toBe(true);
  });
});

describe('ffmpegAvailable', () => {
  it('probes once per path and caches the result for a burst of requests', async () => {
    const path = '/spec/ffmpeg-cached';
    const child = fakeChild();
    const { spawnFn, spawn } = fakeSpawn(child);

    const first = ffmpegAvailable(path, { spawn: spawnFn });
    const second = ffmpegAvailable(path, { spawn: spawnFn });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(path, ['-version'], { stdio: 'ignore' });

    child.emit('close', 0, null);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it('resolves false instead of throwing when the probe cannot start', async () => {
    const spawnFn = vi.fn(() => {
      throw new Error('spawn ENOENT');
    }) as unknown as SpawnFn;

    await expect(ffmpegAvailable('/spec/ffmpeg-missing', { spawn: spawnFn })).resolves.toBe(false);
  });
});

// Guarded so the suite still passes on a machine without ffmpeg installed.
const realFfmpeg = await ffmpegAvailable('ffmpeg');

describe.skipIf(!realFfmpeg)('real ffmpeg', () => {
  it('turns a piped WAV into an ADTS AAC stream', async () => {
    const transcoder = createTranscoder({ ffmpegPath: 'ffmpeg', offsetSec: 0 });
    const chunks: Buffer[] = [];
    transcoder.stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve, reject) => {
      transcoder.stream.once('end', resolve);
      transcoder.stream.once('error', reject);
    });

    transcoder.stdin.end(wavSilence(0.2));
    await ended;
    await transcoder.done;

    const output = Buffer.concat(chunks);
    // ADTS sync word: 12 set bits, then the MPEG version/layer bits.
    expect(output.length).toBeGreaterThan(0);
    expect(output[0]).toBe(0xff);
    expect(output[1] & 0xf0).toBe(0xf0);
  });
});
