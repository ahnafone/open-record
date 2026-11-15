import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { YtDlpError } from '../services/ytdlp';
import { sendError } from './errors';

/** A minimal FastifyReply: records the status, body and log calls sendError makes. */
function fakeReply(body: unknown) {
  const warn = vi.fn();
  const sent: { status?: number; payload?: unknown } = {};
  const reply = {
    request: { body, log: { warn } },
    code(status: number) {
      sent.status = status;
      return reply;
    },
    header() {
      return reply;
    },
    send(payload: unknown) {
      sent.payload = payload;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, warn, sent };
}

describe('sendError for yt-dlp failures', () => {
  it('answers the error status (422 by default) with the reason as JSON', () => {
    const { reply, sent } = fakeReply(undefined);
    sendError(reply, new YtDlpError('yt-dlp failed'));
    expect(sent).toEqual({ status: 422, payload: { error: 'yt-dlp failed' } });
  });

  it('keeps an explicit status such as the 408 timeout', () => {
    const { reply, sent } = fakeReply(undefined);
    sendError(reply, new YtDlpError('yt-dlp timed out', 408));
    expect(sent).toEqual({ status: 408, payload: { error: 'yt-dlp timed out' } });
  });

  it('logs the status and reason once, at warn, as "resolve failed"', () => {
    const { reply, warn } = fakeReply(undefined);
    sendError(reply, new YtDlpError('Sign in to confirm your age.'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 422, err: 'Sign in to confirm your age.' }),
      'resolve failed',
    );
  });

  it('logs the body url without its query, fragment or credentials', () => {
    const { reply, warn } = fakeReply({
      url: 'https://user:pw@www.youtube.com/watch?v=abc&token=secret#t=1',
      cookies: 'SID=abc',
    });
    sendError(reply, new YtDlpError('yt-dlp failed'));
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields['url']).toBe('https://www.youtube.com/watch');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/token|secret|SID|pw@|cookies/);
  });

  it('redacts URLs echoed in the message, but keeps the response body unchanged', () => {
    const message = 'ERROR: https://cdn.example.com/a.mp3?sig=xyz failed';
    const { reply, warn, sent } = fakeReply(undefined);
    sendError(reply, new YtDlpError(message));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'ERROR: https://cdn.example.com/a.mp3 failed' }),
      'resolve failed',
    );
    expect(sent.payload).toEqual({ error: message });
  });

  it.each([
    ['missing body', undefined],
    ['null body', null],
    ['string body', 'https://youtube.com/watch'],
    ['non-string url', { url: 5 }],
    ['unparseable url', { url: 'not a url' }],
    ['non-http url', { url: 'file:///etc/passwd' }],
  ])('does not throw for a %s and logs no url', (_label, body) => {
    const { reply, warn, sent } = fakeReply(body);
    expect(() => sendError(reply, new YtDlpError('yt-dlp failed'))).not.toThrow();
    expect(sent.status).toBe(422);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ url: undefined });
  });

  it('rethrows errors it does not know', () => {
    const { reply, warn } = fakeReply(undefined);
    expect(() => sendError(reply, new Error('boom'))).toThrow('boom');
    expect(warn).not.toHaveBeenCalled();
  });
});
