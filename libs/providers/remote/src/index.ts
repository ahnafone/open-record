// Public API for @open-record/providers/remote (download server client + provider).
export {
  normalizeBaseUrl,
  parseAliases,
  parseEnrichMatch,
  parsePlaylist,
  parseSearchResult,
  parseStream,
  RemoteClient,
  type RemoteAppConfig,
  type RemoteAuthOptions,
  type RemoteConfig,
  type RemoteStream,
  type TrackAliasQuery,
  type TrackAliases,
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
  playlistEntryToTrack,
  RemoteProvider,
  remoteTrackId,
  toRemoteTrack,
  UNKNOWN_ARTIST,
  urlFromRemoteTrackId,
  type ArtistLookup,
  type ImportedPlaylist,
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
