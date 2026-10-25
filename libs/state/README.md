# state

Signal stores the screens use. All are `providedIn: 'root'`, hydrate from
`StoragePort` on construction, update signals optimistically and roll back
(and rethrow) when a write fails.

## Ports (provided by the app)

State may not import provider libs, so it defines an abstract class the app
provides (`apps/app/src/app/app.config.ts`). It is optional; without it
importing is unavailable.

- `LocalMediaPort`: imported-file storage. Provided by the `LocalProvider`
  instance that is also registered in `MusicSourceRegistry` (so imported
  tracks, ids `local:<key>`, play through `PlayerStore` like any other track).

## SettingsStore

- `hydrated: Signal<boolean>`, `ready()`, `reload()`

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
  opens the picker and persists the tracks.
- `updateTrack(id, edit: TrackEdit): Promise<Track>` where
  `TrackEdit = { title?, artist?, album?: string | null, year?: number | null, genre?: string | null }`.
  Imported tracks only. Changed fields are added to `track.userEdited`. Throws on empty title/artist or a bad year.
- `removeImported(id)`: deletes the record and files and removes the id from
  saved records, playlists and the play queue.
- `clearImported()`: the same for every imported track.
- `clearAll()`: stops playback, deletes imported files and every stored
  collection, reloads library, playlists and settings (back to defaults).
- `storageUsage(): Promise<StorageUsage>`:
  `{ importedAudioBytes, artBytes, metadataBytes, catalogBytes: number | null, removableBytes }`.
  `catalogBytes` is measured once with HEAD requests (null if unmeasurable).

## PlaylistsStore

Adds `removeTracksEverywhere(ids)` and `reload()` to the playlist CRUD API.

## PlayerStore

Adds `removeTracks(ids)`: drops tracks from the queue, keeping the current
track and position when it survives.

## Running unit tests

Run `nx test state` to execute the unit tests.
