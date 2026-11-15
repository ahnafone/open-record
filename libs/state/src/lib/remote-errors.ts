/**
 * Friendly copy for download-server failures. State cannot import the
 * provider's error classes, so errors are matched on `error.name`.
 */
export function remoteErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message.trim() : '';
  switch (name) {
    case 'AuthError':
      return 'Sign in to use the download server.';
    case 'NetworkError':
      // The server answered, but the audio file itself could not be fetched
      // (browsers block cross-site downloads of the audio CDN).
      if (/fetch the audio/i.test(message))
        return 'Could not download the audio file. Streaming still works.';
      return 'Could not reach the download server.';
    case 'RemoteConfigError':
      return message || 'Set up a download server in Settings.';
    case 'ProtocolError':
      return 'The server sent a reply this app does not understand.';
    case 'AbortedError':
    case 'AbortError':
      return 'Cancelled.';
    case 'busy': {
      const sec = busyRetryAfterSec(error);
      const wait = sec ? `try again in ${Math.ceil(sec)}s` : 'try again in a moment';
      // The guest share of the server's yt-dlp slots is full (503 guest_busy).
      if ((error as { code?: unknown }).code === 'guest_busy')
        return `Guest streaming is busy right now, ${wait}. Sign in to keep going.`;
      return `Server is busy, ${wait}.`;
    }
    case 'guest_limit':
      return 'Guest limit reached. Sign in or request access to keep going.';
    case 'guest_host_not_allowed':
      return 'Guests can only play links from YouTube, SoundCloud and Bandcamp. Sign in to continue.';
    case 'HttpError':
      return message
        ? `Server error: ${message}`
        : 'The server returned an error.';
    default:
      return message || 'Something went wrong.';
  }
}

/** True for a cancellation (AbortSignal), which is not a failure to show. */
export function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortedError' || error.name === 'AbortError')
  );
}

/**
 * For a busy / rate-limited error (`RemoteBusyError`, HTTP 503/429): the
 * server's Retry-After hint in seconds, when it sent a usable one.
 */
export function busyRetryAfterSec(error: unknown): number | undefined {
  const sec = Number((error as { retryAfterSec?: unknown } | null)?.retryAfterSec);
  return Number.isFinite(sec) && sec > 0 ? sec : undefined;
}

/**
 * Whether a failed save says something about the whole download path
 * (`'systemic'`: offline, server unreachable or erroring, signed out, not set
 * up, yt-dlp itself failing) or only about that one track (`'track'`: removed,
 * private or age/region-locked video, a link the server cannot turn into audio,
 * a bad file). Auto-download pauses on a run of systemic failures and simply
 * moves on after a track failure.
 *
 * HTTP errors are classified in this order:
 * 1. A message naming the video's own problem (`TRACK_PROBLEM`) is `'track'`,
 *    whatever the status.
 * 2. A bot check or a generic yt-dlp failure (`YT_DLP_FAILURE`, e.g. "yt-dlp
 *    failed", "yt-dlp timed out") is `'systemic'`, even as a 4xx: the server
 *    answers those 422, and older servers answered 502.
 * 3. Any 5xx, 408 or status-less error is `'systemic'`.
 * 4. A 422 is `'track'` only for the server's own per-link verdicts
 *    (`PER_TRACK_422`); any other 422 is a yt-dlp failure and `'systemic'`.
 * 5. Remaining 4xx are `'track'`.
 */
export function failureKind(error: unknown): 'systemic' | 'track' {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NetworkError':
    case 'AuthError':
    case 'RemoteConfigError':
    case 'ProtocolError':
    case 'busy':
      return 'systemic';
    case 'HttpError': {
      const message = (error as Error).message;
      if (TRACK_PROBLEM.test(message)) return 'track';
      if (YT_DLP_FAILURE.test(message)) return 'systemic';
      const status = Number((error as { status?: unknown }).status);
      if (!Number.isFinite(status) || status >= 500 || status === 408) return 'systemic';
      if (status === 422) return PER_TRACK_422.test(message) ? 'track' : 'systemic';
      return 'track';
    }
    default:
      return 'track';
  }
}

/** yt-dlp messages about one video (removed, private, age or region locked). */
const TRACK_PROBLEM =
  /video unavailable|private video|confirm your age|age[- ]restricted|not available in your country|removed|terminated|no direct audio link/i;

/** yt-dlp failures that name no video problem: a bot check or yt-dlp itself failing. */
const YT_DLP_FAILURE = /not a bot|yt-dlp (failed|timed out|returned)/i;

/**
 * The server's own per-link 422s (not a yt-dlp run failing): the link is
 * segmented, live, invalid or a playlist.
 */
const PER_TRACK_422 =
  /segmented streams|live streams|invalid link|playlists are not supported|no direct audio link/i;

/** True when the server said it is busy or rate limited (retry later). */
export function isBusy(error: unknown): boolean {
  return error instanceof Error && error.name === 'busy';
}
