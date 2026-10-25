// Public API for @open-record/providers/remote (download server client + provider).
export {
  normalizeBaseUrl,
  parseSearchResult,
  parseStream,
  RemoteClient,
  type RemoteConfig,
  type RemoteStream,
} from './lib/client';
export {
  createLinkCache,
  LINK_EXPIRY_MARGIN_MS,
  type ExpiringLink,
  type LinkCacheOptions,
} from './lib/link-cache';
export {
  RemoteStreamResolver,
  SAVED_DIR,
  savedFilePath,
  type RemoteStreamResolverOptions,
  type SaveBlob,
  type SaveToDeviceOptions,
  type SavedFile,
  type StreamLink,
  type StreamMeta,
} from './lib/stream-resolver';
export {
  AbortedError,
  AuthError,
  BUSY_ERROR_NAME,
  HttpError,
  NetworkError,
  ProtocolError,
  RemoteBusyError,
  RemoteConfigError,
  RemoteError,
} from './lib/errors';
export {
  REMOTE_PROVIDER_ID,
  RemoteProvider,
  remoteTrackId,
  toRemoteTrack,
  urlFromRemoteTrackId,
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
