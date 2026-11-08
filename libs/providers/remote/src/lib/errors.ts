/** Base class for every failure talking to the download server. */
export class RemoteError extends Error {
  // Explicit names (not `new.target.name`): minified builds rename classes, and
  // the state layer matches errors by `name`.
  override name = 'RemoteError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The server is not configured (no URL), or the URL is not http(s). */
export class RemoteConfigError extends RemoteError {
  override name = 'RemoteConfigError';
}

/** The server could not be reached (offline, DNS, TLS, CORS, timeout). */
export class NetworkError extends RemoteError {
  override name = 'NetworkError';
}

/** 401/403: not signed in, or the token was rejected. */
export class AuthError extends RemoteError {
  override name = 'AuthError';

  constructor(
    readonly status: number,
    message = 'Sign in to use the download server.',
  ) {
    super(message);
  }
}

/** Any other non-2xx response. `message` is the server's error text when it sent one. */
export class HttpError extends RemoteError {
  override name = 'HttpError';

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The response was not the JSON shape the contract promises. */
export class ProtocolError extends RemoteError {
  override name = 'ProtocolError';
}

/** The caller aborted (AbortSignal). */
export class AbortedError extends RemoteError {
  override name = 'AbortedError';

  constructor() {
    super('Cancelled');
  }
}

/** Error name of {@link RemoteBusyError}: the server's resolve queue is full (HTTP 503) or it rate limited us (HTTP 429). */
export const BUSY_ERROR_NAME = 'busy';

/** The server is busy or rate limited (HTTP 503/429 + Retry-After). Retry later; `retryAfterSec` is the server's hint. */
export class RemoteBusyError extends RemoteError {
  override name = BUSY_ERROR_NAME;

  /** `guest_busy` when the busy answer is for a guest (the guest yt-dlp share is full). */
  constructor(
    readonly retryAfterSec?: number,
    readonly code?: string,
  ) {
    super('The server is busy. Try again in a moment.');
  }
}

/** Error name of {@link GuestHostError}. */
export const GUEST_HOST_ERROR_NAME = 'guest_host_not_allowed';

/**
 * HTTP 403 `guest_host_not_allowed`: a guest asked for a site the server does
 * not allow guests. Not a session problem: no sign-in prompt, no flag re-read.
 */
export class GuestHostError extends RemoteError {
  override name = GUEST_HOST_ERROR_NAME;

  constructor() {
    super('Guests can only play links from YouTube, SoundCloud and Bandcamp.');
  }
}

/** Error name of {@link GuestLimitError}. */
export const GUEST_LIMIT_ERROR_NAME = 'guest_limit';

/**
 * HTTP 429 with error code `guest_limit`: a signed-out (guest) caller hit the
 * public server's guest allowance. Signing in or requesting access lifts it.
 */
export class GuestLimitError extends RemoteError {
  override name = GUEST_LIMIT_ERROR_NAME;

  constructor(readonly retryAfterSec?: number) {
    super('Guest limit reached. Sign in or request access to keep going.');
  }
}
