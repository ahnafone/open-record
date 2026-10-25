# state

Signal stores the screens use. All are `providedIn: 'root'`, hydrate from
`StoragePort` on construction, update signals optimistically and roll back
(and rethrow) when a write fails.

## Ports (provided by the app)

State may not import provider or metadata libs, so it defines two abstract
classes the app provides (`apps/app/src/app/app.config.ts`). Both are
optional; without them importing and online metadata are unavailable.

- `LocalMediaPort`: imported-file storage. Provided by the `LocalProvider`
  instance that is also registered in `MusicSourceRegistry` (so imported
  tracks, ids `local:<key>`, play through `PlayerStore` like any other track).
- `MetadataPort`: MusicBrainz / Cover Art Archive lookups. Provide exactly one
  app-wide `MetadataService` (it owns the 1 req/s queue).

## SettingsStore

- `onlineMetadata: Signal<boolean>`: user setting, default `true`.
- `onlineSupported: boolean`: lookups can run here (false on web).
- `onlineEnabled: Signal<boolean>`: allowed and supported (and hydrated).
- `setOnlineMetadata(on: boolean): Promise<void>`
- `ready()`, `reload()`

## LibraryStore

Tracks and saved records:

- `tracks`, `trackMap`, `savedIds`, `savedRecords`, `status`, `error`
- `importedTracks: Signal<Track[]>`, `isImported(track)`
- `track(id)`, `resolveIds(ids)`, `isSaved(id)`, `toggleSaved(id)`,
  `setSaved(id, saved)`, `remember(tracks)`, `ready()`, `reload()`
- `search(query): Promise<Track[]>`: provider search plus local matching of
  imported tracks (title, artist, album, genre, year). Blank returns all.
- `artUrl(track): Promise<string | undefined>`: provider `artUrl`, else the
  stored cover of an imported track. Resolve at display time; never persist.

Imported files:

- `canImport: boolean`
- `importFiles(): Promise<{ imported: Track[]; failures: LocalImportFailure[] }>`:
  opens the picker, persists the tracks, queues lookups when enabled.
- `updateTrack(id, edit: TrackEdit): Promise<Track>` where
  `TrackEdit = { title?, artist?, album?: string | null, year?: number | null, genre?: string | null }`.
  Imported tracks only. Changed fields are added to `track.userEdited` and are
  never overwritten by enrichment. Throws on empty title/artist or a bad year.
- `removeImported(id)`: deletes the record and files and removes the id from
  saved records, playlists and the play queue.
- `clearImported()`: the same for every imported track.
- `clearAll()`: stops playback, deletes imported files and every stored
  collection, reloads library, playlists and settings (back to defaults).
- `storageUsage(): Promise<StorageUsage>`:
  `{ importedAudioBytes, artBytes, metadataBytes, catalogBytes: number | null, removableBytes }`.
  `catalogBytes` is measured once with HEAD requests (null if unmeasurable).

Online metadata:

- `onlineAvailable: Signal<boolean>` (same as `SettingsStore.onlineEnabled`)
- `enrichProgress: Signal<{ running; done; total }>`
- Background enrichment runs one track at a time while online metadata is
  enabled, for imported tracks whose `enrichment` is `none` or `pending`. It
  fills only empty, non-user-edited fields (album, year, genre, duration,
  cover) and stores MBIDs, then marks the track `done` or `failed`. Fetched
  cover art is saved through `LocalMediaPort.storeCover`.
- `refreshMetadata(ids?)`: queue tracks (including failed ones) again.
- `enrichmentIdle(): Promise<void>`
- `onlineSearch(query): Promise<OnlineRecording[]>`: info-only results, `[]`
  when disabled or unsupported. Never throws.

## PlaylistsStore

Adds `removeTracksEverywhere(ids)` and `reload()` to the playlist CRUD API.

## PlayerStore

Adds `removeTracks(ids)`: drops tracks from the queue, keeping the current
track and position when it survives.

## Running unit tests

Run `nx test state` to execute the unit tests.
