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

/** 401/403: missing or wrong token. */
export class AuthError extends RemoteError {
  override name = 'AuthError';

  constructor(
    readonly status: number,
    message = 'The download server rejected the token.',
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

/** Error name of {@link RemoteBusyError}: the server's resolve queue is full (HTTP 503). */
export const BUSY_ERROR_NAME = 'busy';

/** The server is busy (HTTP 503 + Retry-After). Retry later; `retryAfterSec` is the server's hint. */
export class RemoteBusyError extends RemoteError {
  override name = BUSY_ERROR_NAME;

  constructor(readonly retryAfterSec?: number) {
    super('The server is busy. Try again in a moment.');
  }
}
