import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MediaRelay, RelayEntry } from '../services/media-relay';
import {
  createTranscoder,
  TranscodeUnavailableError,
  type FfmpegProbe,
  type TranscodeFactory,
  type Transcoder,
} from '../services/transcode';

/** Injected seams for the ffmpeg fallback (`RouteOptions` overrides in tests). */
export interface TranscodeDeps {
  transcode: TranscodeFactory;
  hasFfmpeg: FfmpegProbe;
  ffmpegPath: string;
}

export function defaultTranscodeDeps(
  overrides: Partial<Pick<TranscodeDeps, 'transcode' | 'hasFfmpeg'>>,
  ffmpegPath: string,
  probe: FfmpegProbe,
): TranscodeDeps {
  return {
    transcode: overrides.transcode ?? createTranscoder,
    hasFfmpeg: overrides.hasFfmpeg ?? probe,
    ffmpegPath,
  };
}

/**
 * Headers for a transcoded stream: ADTS AAC, chunked (the duration is unknown
 * up front) and explicitly not seekable, so a player does not retry ranges.
 */
const TRANSCODE_HEADERS: Record<string, string> = {
  'content-type': 'audio/aac',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-disposition': 'inline',
  'accept-ranges': 'none',
};

/**
 * At most one ffmpeg per relay entry (T6.1's "one ffmpeg per active cast
 * stream"). The receiver gets exactly one signed URL per stream, so a second
 * GET on the same entry means a retry after a blip; it supersedes the stale
 * attempt (kill its encoder, drop its source) rather than being rejected,
 * because a 409/503 would leave the speaker silent.
 */
const activeTranscodes = new Map<string, () => void>();

/**
 * Pipes `source` (upstream bytes or a local file) through ffmpeg to ADTS AAC and
 * answers with it. Shared by remote, catalog and upload relays so every source
 * that a receiver cannot play directly goes through one encoder path.
 *
 * The caller owns the head of the response: nothing is written before the
 * ffmpeg availability check, so a 503 is still possible here.
 */
export async function streamTranscoded(
  entry: RelayEntry,
  source: Readable,
  relay: MediaRelay,
  request: FastifyRequest,
  reply: FastifyReply,
  offsetSec: number,
  ffmpeg: TranscodeDeps,
): Promise<FastifyReply> {
  // Source errors can fire during the ffmpeg probe below; they must not become
  // uncaught 'error' events on the stream.
  source.once('error', () => undefined);

  if (!(await ffmpeg.hasFfmpeg(ffmpeg.ffmpegPath))) {
    source.destroy();
    request.log.info({ trackId: entry.trackId, status: 503 }, 'cast relay failed');
    return reply.code(503).send({ error: 'ffmpeg-missing' });
  }

  // Fastify serves HEAD through the GET handler. A HEAD (or probe) must not
  // supersede the live encoder of this entry nor spawn one: headers only, and
  // only once ffmpeg is known to exist (the stream it promises needs it).
  if (request.method === 'HEAD') {
    source.destroy();
    return reply.code(200).headers(TRANSCODE_HEADERS).send();
  }

  // Supersede the previous attempt for this entry before starting a new encoder
  // (the previous callable kills its ffmpeg and destroys its source).
  activeTranscodes.get(entry.id)?.();

  let transcoder: Transcoder;
  try {
    transcoder = ffmpeg.transcode({ ffmpegPath: ffmpeg.ffmpegPath, offsetSec });
  } catch (error) {
    source.destroy();
    if (error instanceof TranscodeUnavailableError) {
      request.log.info({ trackId: entry.trackId, status: 503 }, 'cast relay failed');
      return reply.code(503).send({ error: 'ffmpeg-missing' });
    }
    throw error;
  }

  /** Kill this stream and drop its source; idempotent on every teardown path. */
  const teardown = (): void => {
    transcoder.kill();
    source.destroy();
  };
  /** Unregister only if this request still owns the entry (a newer stream may have replaced it). */
  const unregister = (): void => {
    if (activeTranscodes.get(entry.id) === teardown) activeTranscodes.delete(entry.id);
  };
  const finish = (): void => {
    unregister();
    teardown();
  };
  activeTranscodes.set(entry.id, teardown);

  // Past this point the response head is committed: a stream error destroys the
  // client socket instead of trying to write a JSON error into the audio body.
  relay.setStream(entry.id, { transcoded: true, offsetSec });
  source.pipe(transcoder.stdin);
  source.once('error', finish);
  reply.hijack();
  reply.raw.writeHead(200, TRANSCODE_HEADERS);
  reply.raw.once('close', finish);
  pipeline(transcoder.stream, reply.raw, (error) => {
    if (!error) {
      // A completed stream must not leave a stale registration behind; its own
      // close handler still runs the (idempotent) kill afterwards.
      unregister();
      return;
    }
    finish();
    reply.raw.destroy();
  });
  // ffmpeg failing after the headers went out can only be surfaced by closing
  // the socket; the receiver then reports idle and the session advances.
  void transcoder.done.catch(() => {
    finish();
    if (!reply.raw.destroyed) reply.raw.destroy();
  });
  return reply;
}
