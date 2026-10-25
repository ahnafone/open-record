/**
 * Friendly copy for download-server failures. State cannot import the
 * provider's error classes, so errors are matched on `error.name`.
 */
export function remoteErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message.trim() : '';
  switch (name) {
    case 'AuthError':
      return 'Server rejected the token.';
    case 'NetworkError':
      return 'Could not reach the download server.';
    case 'RemoteConfigError':
      return message || 'Set up a download server in Settings.';
    case 'ProtocolError':
      return 'The server sent a reply this app does not understand.';
    case 'AbortedError':
    case 'AbortError':
      return 'Cancelled.';
    case 'DownloadFailedError':
      return message
        ? `Download failed: ${message}`
        : 'The server could not download this.';
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
