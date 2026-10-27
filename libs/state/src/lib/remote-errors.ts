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
      return sec
        ? `Server is busy, try again in ${Math.ceil(sec)}s.`
        : 'Server is busy, try again in a moment.';
    }
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
 * up) or only about that one track (`'track'`: removed or region-blocked
 * video, a 4xx for its audio, a bad file). Auto-download pauses on a run of
 * systemic failures and simply moves on after a track failure.
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
      // yt-dlp failures come back as 502 but often name the video's own problem.
      if (TRACK_PROBLEM.test((error as Error).message)) return 'track';
      const status = Number((error as { status?: unknown }).status);
      return !Number.isFinite(status) || status >= 500 || status === 408
        ? 'systemic'
        : 'track';
    }
    default:
      return 'track';
  }
}

/** yt-dlp messages about one video (removed, private, age or region locked). */
const TRACK_PROBLEM =
  /video unavailable|private video|confirm your age|age[- ]restricted|not available in your country|removed|terminated|no direct audio link/i;

/** True when the server said it is busy or rate limited (retry later). */
export function isBusy(error: unknown): boolean {
  return error instanceof Error && error.name === 'busy';
}
