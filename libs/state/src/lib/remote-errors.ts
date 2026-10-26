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
    case 'busy':
      return 'Server busy, try again.';
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
