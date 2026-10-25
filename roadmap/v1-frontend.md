# v1: Frontend app

Fully working client app, no backend (network limited to metadata and cover-art lookups), installable on Android and iOS, also runs in a browser.

## Goals

- All six mockup screens working with real audio and persistent local data.
- Play bundled public-domain records and user-imported local files.
- Offline-first; background playback with lock-screen controls.
- Pixel/behaviour fidelity to the mockup and DESIGN.md.

## Non-goals

- Backend of any kind: accounts, sync, cloud storage, realtime anything (v2). The only network calls allowed are metadata and cover-art lookups (MusicBrainz, Cover Art Archive); never audio.
- YouTube or any downloader-backed source, and any audio download or downloader code (v2, see [v2-backend.md](v2-backend.md)).
- Real collaborators (v2).

## Architecture

**Stack:** Angular (latest stable, standalone components, signals) + Capacitor. No Ionic; UI is custom, built from DESIGN.md tokens as CSS variables (colors, Georgia/system-ui type scale, 3/8/999px radii, 44px touch targets).

**Nx workspace**

```
apps/app/                 Angular + Capacitor shell (android/, ios/)
libs/models/              Track, Playlist, Member, Role types (no deps)
libs/music-source/        MusicSourceProvider interface + registry
libs/providers/local/     user-imported files provider
libs/providers/catalog/   bundled public-domain catalog provider
libs/metadata/            MusicBrainz + Cover Art Archive lookups (native only, rate limited)
libs/state/               player, library, playlists, settings stores (signals)
libs/storage/             persistence port + SQLite/IndexedDB adapters
libs/player/              audio engine + media-session wrapper
libs/ui/                  tokens.css, buttons, chips, sleeve/disc, modal, toast
libs/features/<screen>/   browse, search, library, playlist, collab, now-playing, settings
```

Enforce boundaries with Nx module-boundary lint tags (features -> state/ui; providers -> models only).

**MusicSourceProvider** (in `libs/music-source`)

```ts
interface MusicSourceProvider {
  id: string;
  capabilities: { search: boolean; download: boolean };
  search(query: string): Promise<Track[]>;
  resolve(trackId: string): Promise<PlayableSource>; // URL/file handle
  download?(trackId: string, sink: DownloadSink): Promise<void>;
}
```

- v1 providers: `local` (file picker import, metadata via tags) and `catalog` (mockup's 5 Wikimedia Commons items with licences/credits from `mockup/ATTRIBUTION.md`).
- Providers are registered at startup; UI never references a concrete provider.

**Capacitor plugins:** Filesystem (imported files, offline copies), a media-session / background-audio plugin (lock-screen controls, metadata, artwork), File Picker (import), `music-metadata` (tag and embedded-art parsing, not a plugin), SQLite (native) with IndexedDB fallback on web behind the storage port, Preferences for small settings. Online lookups use native HTTP (CapacitorHttp) via `libs/metadata`; they are skipped on web.

**Persistence:** playlists, saved records (bookmarks), imported track metadata, queue/last position, settings. Versioned schema with migrations.

## Milestones

### M0 Foundations
- [x] Nx workspace, Angular app, Capacitor Android + iOS projects
- [x] CI-style scripts: Nx lint, type check, build (per AGENTS.md)
- [x] `ui` lib: DESIGN.md tokens as CSS variables (base components land in M2)
- [x] Module-boundary lint rules

### M1 Data and player core
- [x] `models`, `MusicSourceProvider`, registry
- [x] `catalog` provider with bundled audio/art and credits
- [x] Storage port + adapters, migrations
- [x] Audio engine: queue, next/prev, shuffle, seek, error handling
- [x] Media session: lock-screen/notification controls, background playback (native `capacitor-plugin-playlist@8` installed and synced, iOS deployment target 18.0, Android 13+ notification permission requested before first play; untested on device)

### M2 Screens (match the mockup)
- [x] **Browse:** "Now on the turntable" spinning disc + sleeve, Play record / Open player, genre bins
- [x] **Search:** title/artist/year/genre, suggestion chips, empty state
- [x] **Library:** saved records (bookmark toggle), playlists with Private/Public tag, New playlist
- [x] **Playlist:** play, shuffle, add records, rename, delete, year/genre per row
- [x] **Now playing:** sleeve art, label, tags, seek bar, persistent mini player (pause, next)
- [x] Tab bar, top bar, modal, toast, confirm dialogs, focus management

### M3 Local files and offline
- [x] Import local audio files (provider `local`), read tags/art, edit title/artist (untested on device)
- [x] Copy into app storage; remove/cleanup (untested on device)
- [x] Bundled catalog works fully offline (untested on device)
- [x] Storage usage view and clear-data option (untested on device)

M3 extras (all untested on device):
- [x] Settings screen at `/settings` (`libs/features/settings`)
- [x] Online metadata via MusicBrainz + Cover Art Archive (`libs/metadata`): native only, behind a user toggle in Settings, results cached on device, attribution shown in Settings; metadata and cover art only, never audio
- [x] App icon and splash screen (`apps/app/resources`)

### M4 Collaborators (stub)
- [x] Decision: hide the screen in v1 (4 tabs); role logic is built in `state` for v2
- [ ] If kept: Private/Public visibility and "Viewing as" role preview with sample members, clearly labelled "sample, no real people" as in the mockup
- [ ] Role-permission logic lives in `state` so v2 reuses it unchanged
- [ ] No sharing/invite UI that implies a working network feature

### M5 Polish and release
- [ ] Accessibility pass (below)
- [ ] Performance: cold start, list virtualization if needed
- [ ] Android: signing, AAB, Play internal testing
- [ ] iOS: signing, background-audio capability, TestFlight
- [ ] In-app About: licences, credits, music disclaimer from README

## Accessibility

- [ ] 44px touch targets, visible focus, contrast per DESIGN.md
- [ ] Screen reader labels, roles and live regions (toast `role=status`), as in the mockup
- [ ] Modal focus trap and focus return
- [ ] Seek bar keyboard/assistive operable; reduced-motion disables disc spin
- [ ] Dynamic text sizes do not break layouts

## Acceptance criteria

- [ ] All six screens (or five plus hidden collaborators) behave like the mockup
- [ ] Plays catalog and imported files; keeps playing with screen locked on Android and iOS
- [ ] Lock-screen play/pause/next/seek work
- [ ] Data survives app restart; works in airplane mode
- [ ] Nx lint, type check, build all pass; small test suite green (queue/persistence/permission logic)
- [ ] No audio downloads and no downloader code in the bundle; metadata lookups only

## Risks

| Risk | Mitigation |
|---|---|
| iOS background audio limits, interruptions, route changes | Enable audio background mode; test on device early (M1); handle interruptions in engine |
| Webview audio quirks (WKWebView/Android) | Spike native-backed audio plugin in M1 before building UI on top |
| Storage limits (IndexedDB eviction, device space) | Prefer native filesystem + SQLite on device; show usage; request persistent storage on web |
| App Store/Play policy on downloaders | None shipped in v1; v2 downloader providers stay out of store builds |
| Imported files carry unknown rights | README disclaimer in About; local-only, never uploaded in v1 |
| Scope creep into backend features | Non-goals list above; collaborators stay a stub |
