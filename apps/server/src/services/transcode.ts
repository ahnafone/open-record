// Transcode fallback for cast sources a receiver cannot decode. The source
// bytes always come from the relay's own validated, IP-pinned fetch and are
// piped into ffmpeg's stdin: ffmpeg never sees a URL, so it cannot be
// redirected onto a private host (see §1.7 of the cast plan).

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** Bitrate for the ADTS AAC fallback: good enough for a speaker, cheap on CPU. */
const ADTS_BITRATE = '192k';

/** Only the tail of ffmpeg's stderr is kept: the first line is rarely the cause. */
const STDERR_TAIL_CHARS = 500;

/**
 * Mimes a Cast receiver plays natively. `audio/mp4` (AAC in MP4) is what yt-dlp
 * prefers for remote streams, so this is the common case and avoids ffmpeg.
 */
const CAST_FRIENDLY_AUDIO_MIMES = new Set([
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
  'audio/mp3',
]);

/** The injected `child_process.spawn`; a seam so tests never start a process. */
export type SpawnFn = typeof spawn;

/** A factory with the shape of {@link createTranscoder}; injected in tests. */
export type TranscodeFactory = typeof createTranscoder;

/** A probe with the shape of {@link ffmpegAvailable}; injected in tests. */
export type FfmpegProbe = typeof ffmpegAvailable;

/** ffmpeg is not installed (or cannot be executed). Callers answer 503. */
export class TranscodeUnavailableError extends Error {
  constructor(message = 'ffmpeg is not available') {
    super(message);
    this.name = 'TranscodeUnavailableError';
  }
}

/**
 * True when a receiver can play `mime` without transcoding.
 *
 * MIME parameters (`; codecs=...`) and case are ignored because providers are
 * sloppy about both. An undefined mime is treated as NOT friendly: the
 * container is unknown, so it may be WebM/Ogg (Opus/Vorbis), which Cast
 * receivers refuse. ADTS AAC is the safe fallback for anything unknown.
 */
export function isCastFriendlyAudio(mime: string | undefined): boolean {
  if (mime === undefined) return false;
  const base = mime.split(';')[0]?.trim().toLowerCase();
  return base !== undefined && base.length > 0 && CAST_FRIENDLY_AUDIO_MIMES.has(base);
}

/**
 * ffmpeg argv for the ADTS fallback. The offset is an INPUT seek (before `-i`):
 * it is only used to restart a transcode at the current position, where
 * keyframe accuracy is irrelevant and skipping bytes up front is cheaper than
 * decoding and discarding them.
 */
export function adtsArgs(offsetSec: number): string[] {
  const offset = Number.isFinite(offsetSec) ? Math.max(0, offsetSec) : 0;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'pipe',
    ...(offset > 0 ? ['-ss', String(offset)] : []),
    '-i',
    'pipe:0',
    '-vn',
    '-f',
    'adts',
    '-b:a',
    ADTS_BITRATE,
    'pipe:1',
  ];
}

export interface TranscoderOptions {
  /** Binary name on PATH or an absolute path (`ServerConfig.ffmpegPath`). */
  ffmpegPath: string;
  /** Seconds into the source to start from; 0 starts at the beginning. */
  offsetSec: number;
  /** Test seam; defaults to `child_process.spawn`. */
  spawn?: SpawnFn;
}

export interface Transcoder {
  /** Source bytes go here; the route pipes the upstream response into it. */
  stdin: Writable;
  /** ADTS AAC comes out here; the route pipes it to the client socket. */
  stream: Readable;
  /** Resolves on exit code 0; rejects with the stderr tail otherwise. */
  done: Promise<void>;
  /** Idempotent: stops ffmpeg and closes stdin. */
  kill(): void;
}

/**
 * Starts one ffmpeg process for one cast stream (the plan caps this at one per
 * active cast). Throws {@link TranscodeUnavailableError} synchronously when the
 * process cannot be started at all; an asynchronous `ENOENT` (the real Node
 * behaviour) rejects `done` with the same typed error instead.
 */
export function createTranscoder(opts: TranscoderOptions): Transcoder {
  const argv = adtsArgs(opts.offsetSec);
  const spawnFn = opts.spawn ?? spawn;

  let child: ChildProcess;
  try {
    child = spawnFn(opts.ffmpegPath, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    throw new TranscodeUnavailableError(
      `cannot start ${opts.ffmpegPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const stdin = child.stdin;
  const stream = child.stdout;
  if (!stdin || !stream) {
    child.kill('SIGKILL');
    throw new TranscodeUnavailableError(`cannot start ${opts.ffmpegPath}: no stdio pipes`);
  }

  // The route destroys stdin when the client goes away; an unhandled EPIPE on
  // a pipe nobody writes to any more must never take the server down.
  stdin.on('error', () => undefined);
  stream.on('error', () => undefined);
  child.stderr?.on('error', () => undefined);

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });

  let settled = false;
  let killed = false;
  const done = new Promise<void>((resolvePromise, rejectPromise) => {
    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      const code = (error as NodeJS.ErrnoException).code;
      rejectPromise(
        code === 'ENOENT'
          ? new TranscodeUnavailableError(`ffmpeg not found: ${opts.ffmpegPath}`)
          : new Error(`ffmpeg failed to start: ${error.message}`),
      );
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise();
        return;
      }
      const tail = stderrTail.trim();
      rejectPromise(
        new Error(
          `ffmpeg exited ${signal ? `on ${signal}` : `with code ${code ?? 'unknown'}`}${
            tail ? `: ${tail}` : ''
          }`,
        ),
      );
    });
  });
  // The route handles `done`; this keeps a rejection caused by a client
  // disconnect from becoming an unhandled rejection.
  done.catch(() => undefined);

  return {
    stdin,
    stream,
    done,
    kill(): void {
      if (killed) return;
      killed = true;
      stdin.destroy();
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited: nothing to stop.
      }
    },
  };
}

/** Probe results per binary path, so a burst of relay requests spawns one probe. */
const availability = new Map<string, Promise<boolean>>();

/**
 * Runs `ffmpegPath -version` at most once per path and caches the result. A
 * missing binary resolves false (the relay answers 503) instead of throwing,
 * and it never fails server startup: cast is optional.
 */
export function ffmpegAvailable(
  ffmpegPath: string,
  opts: { spawn?: SpawnFn } = {},
): Promise<boolean> {
  const cached = availability.get(ffmpegPath);
  if (cached) return cached;
  const probe = probeFfmpeg(ffmpegPath, opts.spawn ?? spawn);
  availability.set(ffmpegPath, probe);
  return probe;
}

function probeFfmpeg(ffmpegPath: string, spawnFn: SpawnFn): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      resolvePromise(available);
    };

    let child: ChildProcess;
    try {
      child = spawnFn(ffmpegPath, ['-version'], { stdio: 'ignore' });
    } catch {
      finish(false);
      return;
    }
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}
