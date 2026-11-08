import { PassThrough, type Readable } from 'node:stream';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MediaRelay, RelayEntry } from '../services/media-relay';
import type { Transcoder } from '../services/transcode';
import { streamTranscoded, type TranscodeDeps } from './cast-transcode';

interface FakeEncoder extends Transcoder {
  killed: boolean;
  stream: PassThrough;
}

/** A transcoder that never finishes on its own, so a live stream stays registered. */
function fakeDeps(): { deps: TranscodeDeps; encoders: FakeEncoder[] } {
  const encoders: FakeEncoder[] = [];
  const deps: TranscodeDeps = {
    ffmpegPath: 'ffmpeg',
    hasFfmpeg: async () => true,
    transcode: () => {
      const stream = new PassThrough();
      const encoder: FakeEncoder = {
        killed: false,
        stdin: new PassThrough(),
        stream,
        done: new Promise<void>(() => undefined),
        kill() {
          if (this.killed) return;
          this.killed = true;
          stream.destroy();
        },
      };
      encoders.push(encoder);
      return encoder;
    },
  };
  return { deps, encoders };
}

describe('cast transcode HEAD requests', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('answers HEAD with headers only and leaves the live ffmpeg stream running', async () => {
    const { deps, encoders } = fakeDeps();
    const entry = { id: 'entry-1', trackId: 'track-1' } as RelayEntry;
    const relay = { setStream: () => undefined } as unknown as MediaRelay;

    app = Fastify();
    app.get('/relay', (request, reply) =>
      streamTranscoded(entry, new PassThrough() as Readable, relay, request, reply, 0, deps),
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    // The speaker's real GET. Node sends the head with the first body bytes, so
    // write one chunk once the encoder exists.
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/relay`, resolve).on('error', reject);
    });
    await vi.waitFor(() => expect(encoders).toHaveLength(1));
    encoders[0]?.stream.write(Buffer.from('audio'));
    const get = await response;
    try {
      expect(get.statusCode).toBe(200);

      // A probe/HEAD on the same URL must not kill or replace the encoder.
      const head = await app.inject({ method: 'HEAD', url: '/relay' });
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-type']).toBe('audio/aac');
      expect(head.body).toBe('');
      expect(encoders).toHaveLength(1);
      expect(encoders[0]?.killed).toBe(false);
    } finally {
      get.destroy();
    }
  });

  it('answers HEAD 503 ffmpeg-missing when ffmpeg is absent, without spawning an encoder', async () => {
    const { deps, encoders } = fakeDeps();
    deps.hasFfmpeg = async () => false;
    const entry = { id: 'entry-2', trackId: 'track-2' } as RelayEntry;
    const relay = { setStream: () => undefined } as unknown as MediaRelay;

    app = Fastify();
    app.get('/relay', (request, reply) =>
      streamTranscoded(entry, new PassThrough() as Readable, relay, request, reply, 0, deps),
    );

    const head = await app.inject({ method: 'HEAD', url: '/relay' });
    expect(head.statusCode).toBe(503);
    expect(head.headers['content-type']).not.toBe('audio/aac');
    expect(encoders).toHaveLength(0);
  });
});
