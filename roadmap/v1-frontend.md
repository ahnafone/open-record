# v1: Frontend app

Fully working client app, with an optional self-hosted stream-link server (see [downloader-server.md](downloader-server.md)). No accounts or cloud backend. Installable on Android and iOS, also runs in a browser.

## Goals

- All six mockup screens working with real audio and persistent local data.
- Play bundled public-domain records and user-imported local files.
- Offline-first; background playback with lock-screen controls.
- Pixel/behaviour fidelity to the mockup and DESIGN.md.

## Non-goals

- Hosted backend of any kind: accounts, sync, cloud storage, realtime anything (v2). The only network calls allowed are to the user's own optional stream-link server (search, resolve, stream link) and, once a server is configured, the iTunes and Deezer metadata APIs (called by the app via `libs/metadata-lookup`); audio bytes come from the source CDN via the link the server returns. Nothing runs unless the user enters a server URL and token in Settings. Stream links are tied to the server's public IP and expire, so streaming and saving work only on the server's network (e.g. home Wi-Fi), not on mobile data elsewhere; a server-side proxy is deliberately out of scope.
- Hosting a downloader for others, multi-user access, and a secure token store (v2, see [v2-backend.md](v2-backend.md)).
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
libs/providers/remote/    client + provider for the stream-link server (stream resolver, save to device)
libs/metadata-lookup/     iTunes + Deezer lookup, scoring (pure; fetch injected)
libs/state/               player, library, playlists, settings stores (signals)
libs/storage/             persistence port + SQLite/IndexedDB adapters
libs/player/              audio engine + media-session wrapper
libs/ui/                  tokens.css, buttons, chips, sleeve/disc, modal, toast
libs/features/<screen>/   browse, search, library, playlist, collab, now-playing, settings
apps/server/              self-hosted stream-link server (Fastify + yt-dlp, Docker)
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

- v1 providers: `remote` (stream-link server, optional, see M3.5), `local` (file picker import, metadata via tags) and `catalog` (mockup's 5 Wikimedia Commons items with licences/credits from `mockup/ATTRIBUTION.md`).
- Providers are registered at startup; UI never references a concrete provider.

**Capacitor plugins:** Filesystem (imported files, offline copies), a media-session / background-audio plugin (lock-screen controls, metadata, artwork), File Picker (import), `music-metadata` (tag and embedded-art parsing, not a plugin), SQLite (native) with IndexedDB fallback on web behind the storage port, Preferences for small settings. Stream-link server and metadata calls use native HTTP (CapacitorHttp) on device and `fetch` on web, via `libs/providers/remote`.

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
- [x] MusicBrainz / Cover Art Archive enrichment was built, then removed in M3.5 (storage migration v3 deletes its setting and fields)
- [x] App icon and splash screen (`apps/app/resources`)

### M3.5 Stream-first downloader

Optional; off until a server URL and token are set. All items untested on device. Details in [downloader-server.md](downloader-server.md).

- [x] `apps/server`: Fastify + yt-dlp, Docker, single-user bearer token; returns stream links only (`POST /stream`, `/search`, `/resolve`, `/ping`), never downloads, tags or serves files; load safeguards (concurrency cap, queue, 503 Retry-After, rate limits, link cache)
- [x] Search (YouTube, YouTube Music, SoundCloud) and pasted links (Bandcamp, Audiomack, Mixcloud, any yt-dlp site)
- [x] Metadata from iTunes Search + Deezer (hi-res art) looked up by the app (`libs/metadata-lookup`) and saved with the track; the server has no `/metadata`
- [x] MusicBrainz and Cover Art Archive removed (code, toggle, credits, setting)
- [x] `libs/providers/remote`: tap an unsaved result streams the link; bookmark or add to a playlist downloads it to the device in the background; removed from the library and all playlists deletes the file
- [x] Settings > Stream server (URL, token, Test connection via `/ping`); Search > Download sources (planned rename: Find online); Android and iOS both use the server URL
- [x] One-command start `npm run server:up` (prints LAN URL, token, QR; token persisted in `/data` or `~/.config/open-record`) and QR pairing: Settings > Stream server > Scan QR code reads `openrecord://pair?...` (both platforms scan; a pasted link also works)
- [x] One-command mobile build scripts: `npm run android` (cap sync, then `cap run android`) and `npm run android:open` (opens Android Studio)
- [x] LAN address chooser in `server:up`: skips 192.0.2.* and Docker bridges, prompts when several candidates exist in a terminal, `--ip` overrides
- [x] iOS QR scanner: in-app JS scanner (jsQR); device test pending
- [x] Token stored in plain text in the settings collection (no secure-storage plugin yet)
- [x] Server URL over HTTPS (Tailscale / Cloudflare tunnel, recommended) or plain HTTP on the home LAN. Decision: Android network security config allows cleartext (base-config; IP ranges cannot be scoped), iOS `NSAllowsLocalNetworking` + local-network usage string, server compose `BIND_ADDRESS` (default `127.0.0.1`). LAN HTTP exposes the token on the network; documented
- [x] Audio quality, auto-download and preloading (all untested on device): Settings > Audio quality (streaming and download quality: Highest default, High ~160, Medium ~128, Low ~64 kbps; optional "use streaming quality for downloads"); `POST /stream` accepts optional `quality` (400 if invalid, link cache per quality); Library auto-download switch (off by default) and per-playlist auto-download switch, Wi-Fi only unless Settings > Allow auto-download on mobile data (`@capacitor/network`, needs `npx cap sync`); saved tracks always play from the device file; the player pre-resolves and preloads the next track ~15 s before the current one ends. Device test pending
- [ ] Device test (pending): stream with the server on the LAN; bookmark, file appears and plays in airplane mode; unbookmark from library and all playlists, file deleted
- [ ] Keep the downloader out of store builds (decide how before M5)

### M4 Collaborators (stub)
Note: the Collaborators screen is hidden in v1 (three tabs plus Settings from the top bar); it stays in the mockup and screenshots only.
- [x] Decision: hide the screen in v1 (3 tabs); role logic is built in `state` for v2
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
- [ ] Without a configured server the app makes no network calls; streaming and saving work only against the user's own server on its network (device test pending; offline playback of saved songs afterwards)
- [ ] Downloader kept out of store builds (or store policy reviewed)

## Risks

| Risk | Mitigation |
|---|---|
| iOS background audio limits, interruptions, route changes | Enable audio background mode; test on device early (M1); handle interruptions in engine |
| Webview audio quirks (WKWebView/Android) | Spike native-backed audio plugin in M1 before building UI on top |
| Storage limits (IndexedDB eviction, device space) | Prefer native filesystem + SQLite on device; show usage; request persistent storage on web |
| App Store/Play policy on downloaders | Server is separate and self-hosted; the app's download UI stays out of store builds until reviewed (sideload / TestFlight only) |
| Stream links tied to the server's public IP and expiring | Works on the server's network only; a proxy would bring back server bandwidth load, so out of scope |
| Token stored in plain text on device | Documented; secure storage plugin in v2 |
| Source ToS, art terms (iTunes, Deezer), yt-dlp breakage | See [downloader-server.md](downloader-server.md) |
| Imported files carry unknown rights | README disclaimer in About; local-only, never uploaded |
| Scope creep into backend features | Non-goals list above; collaborators stay a stub |
