// Public API for @open-record/providers/remote (download server client + provider).
export {
  normalizeBaseUrl,
  parseFileHeaders,
  parseJob,
  parseSearchResult,
  RemoteClient,
  type AuthorizedRequest,
  type RemoteConfig,
  type WaitOptions,
} from './lib/client';
export {
  BlobDownloadTarget,
  buildFileName,
  createDefaultDownloadTarget,
  DOWNLOAD_CACHE_DIR,
  NativeDownloadTarget,
  type DownloadedFile,
  type DownloadTarget,
  type DownloadTargetRequest,
} from './lib/download-target';
export {
  AbortedError,
  AuthError,
  DownloadFailedError,
  HttpError,
  NetworkError,
  ProtocolError,
  RemoteConfigError,
  RemoteError,
} from './lib/errors';
export {
  REMOTE_PROVIDER_ID,
  RemoteProvider,
  remoteTrackId,
  toRemoteTrack,
  urlFromRemoteTrackId,
  type DownloadImporter,
  type DownloadPhase,
  type DownloadProgress,
  type DownloadToLibraryOptions,
  type RemoteProviderOptions,
} from './lib/remote-provider';
export {
  createCapacitorHttpTransport,
  createDefaultTransport,
  createFetchTransport,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './lib/transport';
