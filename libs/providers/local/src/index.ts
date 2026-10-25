// Public API for @open-record/providers/local.
export { LocalProvider, type ImportFailure, type ImportResult } from './lib/local-provider';
export {
  createDefaultFileStore,
  IMPORT_DIR,
  IndexedDbFileStore,
  NativeFileStore,
  type LocalFileStore,
  type PickedAudio,
  type StoredFileEntry,
} from './lib/file-store';
export { pickAudioFiles } from './lib/pick-audio';
export {
  LOCAL_PROVIDER_ID,
  localKeyFromTrackId,
  localTrackId,
  parseFileName,
  toLocalTrack,
  type LocalFileInfo,
  type LocalTagInfo,
} from './lib/local-tracks';
