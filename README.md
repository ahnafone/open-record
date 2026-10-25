# Open Record

A vinyl record-shop listening room for your phone: browse the crates, build playlists, share them with collaborators, and play it all on a virtual turntable.

![Open Record overview](docs/screenshots/00-overview.png)

> **Notices**
>
> - **AI-built:** this app will be created using AI agents. See [AGENTS.md](AGENTS.md) for the rules they follow.
> - **Design:** the design and mockup were created using the Open Design app. The design system is documented in [DESIGN.md](DESIGN.md).
> - **Music disclaimer:** the author is not responsible for any music that users choose to download, and owns no copyrights to any songs downloaded. Users are solely responsible for ensuring they have the rights to any music they download or use.

## Status

v1 (frontend app) is in progress: the Angular + Capacitor app has the five screens, local file import, Settings, and an optional self-hosted stream-link server (`apps/server`) with in-app search, streaming, and save-to-device. None of it has been tested on a device yet (device testing is still pending). The interactive mobile mockup is in `mockup/`.

## Roadmap

Plans for v1 (frontend app), v2 (backend) and later are in [roadmap/](roadmap/README.md).

## Features (as shown in the mockup)

- **Browse:** "The listening room" home with a "Now on the turntable" record (spinning disc and sleeve), Play record / Open player buttons, and genre bins (All, Dance band, Fox trot, Ragtime and more).
- **Search:** search by title, artist, year or genre, with quick suggestions such as Sousa, Ragtime, 1920 and Bach.
- **Library:** saved records (bookmark toggle) and your playlists, each marked Private or Public, with a New playlist button.
- **Playlists:** play or shuffle, add records, rename, delete, and see each record's year and genre.
- **Collaborators:** Private/Public visibility, plus Owner, Editor (can manage records) and Viewer (can listen) roles. A "Viewing as" switch previews what each role can do; members are samples only.
- **Import local files:** add your own audio files (tags and embedded art are read, titles and artists are editable) and play them alongside the bundled records.
- **Stream and save (optional):** with your own [stream-link server](apps/server/README.md), search YouTube, YouTube Music and SoundCloud, or paste a link (Bandcamp, Audiomack, Mixcloud and other yt-dlp sites). The server only finds a direct link; the app streams it, and the download happens on your device. Tap a result to stream it; bookmarking it or adding it to a playlist saves the file to your device in the background, and removing it from the library and all playlists deletes the file. The app looks up tags and hi-res cover art from iTunes and Deezer itself and saves them with the track. Links are tied to the server's public IP and expire, so streaming and saving work on the same network as the server (e.g. home Wi-Fi), not on a different network such as mobile data. Android and iOS both use the server URL.
- **Settings:** storage usage, clear data, Stream server (URL, token, test connection, Scan QR code to pair on Android), and credits.
- **Now playing:** full-screen player with sleeve art, label, year and genre tags, seek bar, plus a persistent mini player with pause and next.

## Screenshots

| | | |
|---|---|---|
| ![Browse](docs/screenshots/01-browse.png) | ![Search](docs/screenshots/02-search.png) | ![Library](docs/screenshots/03-library.png) |
| **Browse:** the listening room and genre bins | **Search:** by title, artist, year or genre | **Library:** saved records and playlists |
| ![Playlist](docs/screenshots/04-playlist.png) | ![Collaborators](docs/screenshots/05-collaborators.png) | ![Now playing](docs/screenshots/06-now-playing.png) |
| **Playlist:** play, shuffle, add, rename, delete | **Collaborators:** visibility and roles | **Now playing:** player with seek bar and mini player |

## Repo layout

```
apps/app/            Angular + Capacitor app (android/, ios/)
apps/server/        Self-hosted stream-link server (Fastify, yt-dlp, Docker)
libs/                Shared libraries (models, state, storage, player, ui, providers, metadata-lookup, features)
mockup/              Interactive HTML mockup (index.html, assets/, ATTRIBUTION.md)
docs/screenshots/    Screenshots of the six screens
roadmap/             Planning docs (v1 frontend, v2 backend, stream-link server, later ideas)
DESIGN.md            Design system
AGENTS.md            Rules for AI agents working on this project
LICENSE              MIT license
```

## View the mockup

Serve the folder, then open the printed address (usually http://localhost:8000):

```bash
cd mockup
python3 -m http.server
```

Or open `mockup/index.html` directly in a browser. Serving is safer for audio playback.

## Sample media

The mockup's sample audio and cover art are openly licensed or public-domain items from Wikimedia Commons. Licences and credits are listed in [mockup/ATTRIBUTION.md](mockup/ATTRIBUTION.md).

## Metadata credits

When you configure the optional stream-link server, the app itself calls (from the device, not through the server) and gets track metadata and cover art from the [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTunesSearchAPI/) and the [Deezer public API](https://developers.deezer.com/api). Cover art remains the copyright of its rights holders. iTunes' terms limit artwork use to promoting store content and Deezer's API terms are unverified, so treat this as a personal, self-hosted tool. Without a server configured, the app makes no network calls.

## Stream-link server

The optional server in [apps/server](apps/server/README.md) uses yt-dlp to search and to return a direct stream link (`POST /stream`); it never downloads, tags or serves audio itself, and has load safeguards (concurrency cap, queue, `503` with `Retry-After`, rate limits, link cache; see `MAX_CONCURRENT_RESOLVES`, `STREAM_CACHE_TTL`, `RESOLVE_RATE_LIMIT_MAX`). Streaming or downloading may break the source site's terms of service; see the music disclaimer above and keep it out of store builds. Quick start:

```bash
npm run server:up
```

It starts the server in Docker and prints the LAN URL, the access token and a QR code. In the app, open Settings > Stream server and tap "Scan QR code" (Android; the iOS scanner is not linked yet, so paste the printed pairing link `openrecord://pair?...` instead). Entering the URL and token manually still works. The token is generated once and persisted in the `/data` volume (or `~/.config/open-record`), so it survives restarts.

Manual Docker run:

```bash
export OPEN_RECORD_TOKEN=$(openssl rand -hex 32)
docker compose -f apps/server/docker-compose.yml up -d --build
curl http://127.0.0.1:8787/health
```

Expose it over HTTPS (Tailscale or a Cloudflare tunnel), or on a trusted home network publish it on your LAN with `BIND_ADDRESS=<lan-ip>` and use `http://<lan-ip>:8787` (unencrypted: the token is visible to others on the network; see the [server README](apps/server/README.md#plain-http-on-your-home-lan)). Then enter the URL and token in the app under Settings, Stream server (or pair by QR). The token is stored in plain text on the device for now. More in [roadmap/downloader-server.md](roadmap/downloader-server.md).

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Ahnaf. Sample media keep their own licences (see above).
