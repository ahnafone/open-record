# Open Record

A vinyl record-shop listening room for your phone and desktop: browse the crates, build playlists,
import your own music, and play it all on a virtual turntable. **Version 0.0.6 (beta).**

![Open Record overview](docs/screenshots/00-overview.png)

## Download

Release notes: [RELEASE_NOTES.md](RELEASE_NOTES.md). Checksums for every release file are in `SHA256SUMS.txt` on the release page.

| Platform | File | Notes |
|---|---|---|
| Linux x64 (recommended) | [OpenRecord-linux-amd64.deb](https://github.com/ahnafone/open-record/releases/latest/download/OpenRecord-linux-amd64.deb) | `sudo apt install ./OpenRecord-linux-amd64.deb` |
| Linux x64 | [OpenRecord-linux-x86_64.AppImage](https://github.com/ahnafone/open-record/releases/latest/download/OpenRecord-linux-x86_64.AppImage) | `chmod +x`, then run |
| Windows x64 | [OpenRecord-windows-x64.exe](https://github.com/ahnafone/open-record/releases/latest/download/OpenRecord-windows-x64.exe) | SmartScreen warning; More info > Run anyway |
| macOS | [Build from source](docs/desktop.md#build-from-source) | Not in v0.0.6; macOS installers coming later |
| Android | [OpenRecord-android.apk](https://github.com/ahnafone/open-record/releases/latest/download/OpenRecord-android.apk) | Android 7+; beta-tested; see [release builds](#release-builds) |
| iPhone / iPad | [Build from source](docs/ios-install.md) | Not tested yet. Mac, Xcode and a free Apple ID; re-sign every 7 days |

Desktop installers are unsigned. Windows and AppImage builds update in the app; `.deb` and macOS builds need a reinstall over the old version. There is no App
Store, TestFlight, Play Store or enterprise build.

> **Notices**
>
> - **AI-built:** this app was built with AI agents. See [AGENTS.md](AGENTS.md) for the rules they follow.
> - **Design:** the design and mockup were created with the [Open Design](https://github.com/nexu-io/open-design) app. The design system is in [DESIGN.md](DESIGN.md).
> - **Music disclaimer:** the author owns no copyrights to any music users download and is not responsible for what they choose to download. You are solely responsible for having the rights to any music you download, stream or use.

## Status

Open Record 0.0.6 is a beta: an Angular + Capacitor app (Android, iOS and web) with a bundled
public-domain catalogue, local imports, playlists, a queue, background downloads and optional
accounts and sync. The Electron desktop app bundles the UI and local server, and
`.github/workflows/desktop-build.yml` builds the desktop installers.

- **Android:** beta-tested on devices.
- **iPhone:** not tested yet. It is build-from-source only (see [docs/ios-install.md](docs/ios-install.md)).
- **Desktop:** installers are unsigned. Windows and AppImage builds update in the app; `.deb` builds only notify you of a new version. macOS installers are not part of v0.0.6; build from source (see [docs/desktop.md](docs/desktop.md#build-from-source)).
- Collaborators is hidden in this release; its role logic is kept for later.

## Web app

The hosted web app is at **https://open-record.uttarasoftware.ca**.

- **Guests** can play the bundled catalogue and stream from search, within rate limits.
- **Library and playlists** need an account. Sign-up is a request: the owner reviews it and approves
  it, and you then get an email to set a password.
- **Desktop app and self-hosted server** skip this gate. They run on your own machine or network.

## Install and run

Prerequisites: **Node 24** and npm. Android builds need the Android SDK; iPhone builds need a Mac
with Xcode; streaming through your own server needs `yt-dlp` (`pipx install yt-dlp`). `ffmpeg` is
optional for Cast transcoding. For the desktop app, see [docs/desktop.md](docs/desktop.md).

```bash
git clone https://github.com/ahnafone/open-record.git
cd open-record
npm ci
```

Run the web UI in development (no API or stream server):

```bash
npm start
```

Or build and serve the web app with the local server:

```bash
npm run server:up          # builds app + server, starts detached, prints URL and QR
npm run server:up -- --stop
```

`server:up` prints `http://<lan-ip>:8787/` and a pairing QR code. Open it, or enter the address in
the phone app under **Settings > Stream server**. `npm run server:dev` runs it in the foreground.

### Android

```bash
npm run android            # cap sync, then run on a device or emulator
npm run android:release    # signed release APK (needs keystore.properties)
npm run android:release:install
```

Release builds need `apps/app/android/keystore.properties` and your own keystore outside the repo;
see [RELEASE_SIGNING.md](apps/app/android/RELEASE_SIGNING.md). For a local performance build only,
`./gradlew assembleRelease -PallowDebugSigning` in `apps/app/android` signs with the debug key.

**Updating without losing your downloads.** Downloads and library data live in app-specific storage
(internal, or the external app folder if you chose it), and uninstalling the app deletes both. Android
only updates in place when the new APK is signed with the same key as the installed one.

- Update with `npm run android:release:install` (or `adb install -r <apk>`). Do not uninstall first.
- Use one signing key for every install on a phone. Do not mix debug builds (`npm run android`,
  `-PallowDebugSigning`) with release builds.
- `INSTALL_FAILED_UPDATE_INCOMPATIBLE` means the keys differ. Install an APK signed with the same
  key as the app already on the phone to keep your data; uninstalling to get past the error deletes it.
- If you use an account, sign in to sync so your library (not the downloaded audio) can be restored
  after a forced reinstall. Songs must be downloaded again.

### Run on iPhone

iPhone builds are from source only: a Mac with Xcode, a free Apple ID, and re-signing from Xcode
every 7 days. This path is **not tested yet**. Follow the step-by-step guide in
[docs/ios-install.md](docs/ios-install.md).

## Desktop app

The desktop app wraps the Angular UI, the local Fastify server, `yt-dlp` and `ffmpeg` in one
Electron application.

- **Offline:** bundled catalogue, local imports, playback, playlists, history and settings. Remote
  search/stream/save, metadata and Supabase need internet; phones need the same LAN.
- **Fixed origin:** `http://127.0.0.1:47900`. Storage is tied to the origin, so a taken port reports
  an error instead of silently changing it.
- **Setup page:** **Settings > Desktop app** (or `http://127.0.0.1:47900/desktop`) saves your
  Supabase project URL and anon key. It refuses `service_role` and `sb_secret_...` keys.
- **Phones on this network:** the toggle restarts the local server on all interfaces and shows the
  LAN address and QR code. Use a trusted Wi-Fi only (plain HTTP), and never port-forward 47900.
- **Unsigned:** expect SmartScreen warnings on Windows. Windows and AppImage builds update in the app; `.deb` builds need a reinstall. The
  data folder and fixed origin preserve your library.

See [docs/desktop.md](docs/desktop.md) for install, data folders, Supabase and troubleshooting.
Build the app for the current OS with `npm run desktop:dist`; `npm run desktop:dev` runs the
Electron shell against the local build.

## Public access

Never port-forward the server or the desktop port (8787, 47900). To reach the server from outside
your network, expose it only over HTTPS through a private network (e.g. Tailscale) or a trusted
reverse proxy that you run yourself, and bind the server to loopback behind it. Set `TRUST_PROXY`
and `PUBLIC_URL` to match your setup. Server settings are in [apps/server/README.md](apps/server/README.md).

## Website

The landing page is the Astro site in `apps/website`. GitHub Actions deploys it to GitHub Pages at
<https://ahnafone.github.io/open-record/>. It is not served from `docs/`; `docs/` holds screenshots
and the runbooks.

## Features

- **Browse:** a "Now on the turntable" record with a spinning disc and sleeve, Play record and Open
  player buttons, and record-shop genre bins (All, Dance band, Fox trot, Ragtime and more).
- **Search:** by title, artist, year or genre, with quick suggestions. With a stream server, search
  YouTube, YouTube Music and SoundCloud, or paste a link from a yt-dlp site.
- **Library:** saved records with a bookmark toggle, plus playlists marked Private or Public. Filter
  by title, artist and album; long lists render as you scroll; on desktop the list is a sortable table.
- **Playlists:** play or shuffle, add records, rename, delete, and reorder. Each row shows its source,
  download state and duration.
- **Now playing and queue:** full-screen player with sleeve art, seek bar and track details, a
  persistent mini player, Play next, Add to Stack and an editable queue (Your Stack and Keep Spinning). Desktop has a resizable side panel,
  keyboard shortcuts and media-key support.
- **Imports:** audio files from the device with editable tags and art; Spotify Exportify CSV or JSON
  from a data download; YouTube / YT Music playlist or song links. Matching runs through your server,
  and uncertain matches wait in a review list. Every import becomes an Import history session.
- **Stream and save:** with your own [stream-link server](apps/server/README.md), the app streams a
  direct link and saves the file on your device. It looks up tags and hi-res cover art from iTunes and
  Deezer. Links are tied to the server's public IP and expire, so streaming and saving work on the
  same network as the server, not on mobile data.
- **Auto-download and recovery:** a Library switch and per-playlist switches save tracks
  automatically, on Wi-Fi by default (mobile data is opt-in). On Android a foreground service keeps
  downloads running with the screen off. Failed songs show a reason, Retry and a Fix link page at
  `/downloads/failed`.
- **Accounts, sync and Cast (optional):** your own Supabase project adds email/password sign-in and
  syncs track metadata, saved songs, playlists, Your Stack and import history, never audio. Conflicts are
  last-write-wins. Signing in also shares the playback queue, and Google Cast speakers on the LAN
  appear in the **Play on** picker.
- **Settings:** storage usage, clear data, separate streaming and download quality, mobile data
  permission, device storage, stream-server address with QR scan, and credits.

## Screenshots

| | |
|---|---|
| ![Browse](docs/screenshots/01-browse.png) | ![Search](docs/screenshots/02-search.png) |
| **Browse:** the listening room and genre bins | **Search:** by title, artist, year or genre |
| ![Library](docs/screenshots/03-library.png) | ![Playlist](docs/screenshots/04-playlist.png) |
| **Library:** saved records and playlists | **Playlist:** play, shuffle, add, rename, delete |

![Now playing](docs/screenshots/06-now-playing.png)

**Now playing:** full-screen player with seek bar, queue and mini player.

![Open Record desktop app](docs/screenshots/07-desktop.png)

**Desktop:** the same library and player in the Electron app, with the local server bundled.

## Release builds

Build and measure with release builds, not debug.

- **Desktop:** `.github/workflows/desktop-build.yml` builds the Linux `.deb`/AppImage and Windows NSIS
  installer on a `v*` tag, writes `SHA256SUMS.txt` and the update feeds `latest.yml` and
  `latest-linux.yml`, and uploads them to the GitHub release. macOS jobs are removed (no macOS runner
  available). All desktop installers are unsigned. Windows and AppImage builds self-update; `.deb` and
  macOS builds only notify.
- **Android:** `npm run android:release` builds the signed APK when `keystore.properties` is
  configured (keystore outside the repo); `android:release:install` installs it. Debug signing is
  opt-in with `-PallowDebugSigning` for local performance builds. The signed `OpenRecord-android.apk`
  is attached to the latest release.
- **iPhone:** build from source in Xcode with a Personal Team; see [docs/ios-install.md](docs/ios-install.md).
  `npm run ios:release` only makes a generic build. No TestFlight; free-account builds expire after 7 days.
- **Checks:** `npm run check` runs token checks, lint, typecheck and build.

## Supabase accounts (optional)

Accounts, sync, Cast and phone sign-in use a Supabase project you create and own; Open Record hosts
no accounts, audio or relay.

1. Create a project at [supabase.com](https://supabase.com), or run `supabase start` locally. Apply
   `supabase/migrations/` in filename order (`npx supabase db push` or the SQL Editor).
2. Enable **Email** auth with a minimum password length of 6, create the owner account, then close
   sign-ups and anonymous sign-ins. Every public table needs row-level security, with no policy for
   the `anon` role.
3. Web/server: set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `apps/server/.env` and restart
   `npm run server:up`. The app reads them from `GET /app-config`.
4. Desktop: save the same values under **Settings > Desktop app** (`/desktop`).

Use the anon key only; never put a `service_role` or `sb_secret_...` key in the server, the desktop
config or a build. Sync covers metadata, saved songs, playlists, Your Stack and import history, never audio;
conflicts are last-write-wins.

## Stream-link server

[apps/server](apps/server/README.md) is a small self-hosted Fastify + `yt-dlp` server. It finds a
direct audio link and returns it; the phone fetches the audio. It never downloads, tags or proxies
audio, except the Cast relay to a Google Cast speaker.

```bash
npm run server:up
```

It needs Node 24 and `yt-dlp` on the host. The generated token lives in `~/.config/open-record/` with
mode 0600, and the command prints the URL and QR code. The server has a concurrency cap, wait queue,
rate limits and a link cache, and returns `503` with `Retry-After` when busy.

Use plain HTTP only on a trusted home LAN; the bearer token is unencrypted. Outside the home, use
HTTPS through Tailscale or a trusted reverse proxy (see [Public access](#public-access)),
and set `TRUST_PROXY` and `PUBLIC_URL`. Never port-forward 8787.

## Repo layout

```
apps/app/              Angular + Capacitor app (android/, ios/)
apps/desktop/          Electron app, installer config and server-package-lock.json
apps/server/           Self-hosted Fastify + yt-dlp stream-link server
apps/website/          Astro landing site, deployed to GitHub Pages
docs/                  Screenshots and guides (ios-install, desktop)
supabase/              Supabase config and SQL migrations (optional accounts)
libs/                  Shared models, state, storage, player, UI and feature libraries
mockup/                Interactive HTML design mockup (index.html, assets/)
.github/workflows/     Desktop installer CI and Pages deploy
DESIGN.md              Design system
AGENTS.md              Rules for AI agents working on this project
RELEASE_NOTES.md       Release notes for the current version
LICENSE                MIT license
```

## Mockup and sample media

The interactive design mockup is in [`mockup/`](mockup/index.html); serve it with
`cd mockup && python3 -m http.server` and open <http://localhost:8000>. Sample audio and cover art
are openly licensed/public-domain Wikimedia Commons items; credits: [mockup/ATTRIBUTION.md](mockup/ATTRIBUTION.md).

## Metadata credits

With a stream server configured, the app calls the [iTunes Search API](https://performance-partners.apple.com/search-api)
and the [Deezer public API](https://developers.deezer.com/api) directly from the device for tags and
cover art. Cover art remains the copyright of its rights holders. iTunes' terms limit artwork use to
promoting store content, and Deezer's API terms are unverified, so treat this as a personal,
self-hosted tool. Without a server configured, the app makes no network calls.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Ahnaf. Sample media keep their own
licences (see [mockup/ATTRIBUTION.md](mockup/ATTRIBUTION.md)).
