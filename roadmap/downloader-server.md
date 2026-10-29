# Stream-link server

Optional self-hosted server (`apps/server`) that lets the app search for audio and get a direct stream link. It never downloads, tags or serves files; the app streams the link and, when a song is saved, downloads it onto the device. Built in v1 as M3.5 ([v1-frontend.md](v1-frontend.md)); multi-user and hardening are v2 ([v2-backend.md](v2-backend.md)). Not tested on a device yet. Run instructions, env vars and full API detail: [apps/server/README.md](../apps/server/README.md).

## Architecture

- **Server:** Node + Fastify, yt-dlp run straight from the host (keep it current with `pipx upgrade yt-dlp`). Single user, one shared bearer token (`OPEN_RECORD_TOKEN`). Imports only `@open-record/models`.
- **Client:** `libs/providers/remote` implements `MusicSourceProvider` over HTTP (CapacitorHttp on native, fetch on web). A track keeps one id (`remote:<url>`) whether streamed or saved; `resolve` returns the local file if saved, else the stream link. Android and iOS both use the server URL.
- **App UI:** Settings > Stream server (URL, token, Scan QR code, Test connection); Search > Download sources (source chips, paste a link); an offline store that saves tracks to the device (queue, progress, retry; planned to resume on startup).
- **Flow:** search or paste link, tap to play (`POST /stream`, play the returned link). Bookmark or add to a playlist: the device downloads the link in the background and keeps the file. Removed from the library and all playlists: the file is deleted. Links are tied to the server's public IP and expire, so this works on the home network but not on a different network (mobile data); a proxy is deliberately out of scope.
- **Setup / pairing:** `npm run server:up` starts the server on this machine and prints the LAN URL, access token and a QR code (pairing link `openrecord://pair?...`). The token is generated once and persisted in `~/.config/open-record`. The app's "Scan QR code" fills URL and token (Android); on iOS paste the pairing link until a scanner is linked. Manual entry still works.
- **Transport:** HTTPS (Tailscale or Cloudflare tunnel) is recommended. Plain HTTP on the home LAN is supported (decision): Android allows cleartext via `res/xml/network_security_config.xml` (base-config, since domain-config cannot match private IP ranges); iOS sets `NSAllowsLocalNetworking` plus `NSLocalNetworkUsageDescription`. Native requests use CapacitorHttp and `Filesystem.downloadFile` (system HTTP stack), so WebView mixed-content rules do not apply. The server binds `0.0.0.0` by default, so the host firewall must allow the port from the LAN.

## Sources

| Kind | Sources |
|---|---|
| Search + stream/save | YouTube, YouTube Music, SoundCloud |
| Pasted link only (no yt-dlp search) | Bandcamp, Audiomack, Mixcloud, any yt-dlp-supported site |
| Metadata only (DRM, not streamable) | Deezer, Spotify, Apple Music, Tidal |

## Metadata

The app looks up metadata itself (`libs/metadata-lookup`): iTunes Search API and Deezer public API are queried in parallel, candidates scored on title, artist and duration, and a confident match gives title, artist, album, year, genre and hi-res art (iTunes 1000x1000, Deezer `cover_xl`). It runs in the background after a save and is saved with the track; no match or a failure keeps the source's own metadata and never fails the save. The server has no `/metadata` and embeds no tags. MusicBrainz and Cover Art Archive are fully removed.

## API

All need `Authorization: Bearer <token>` except `/health`.

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness (no auth) |
| `GET /ping` | authed check used by Test connection |
| `GET /search?q&source` | search youtube, ytmusic, soundcloud (max 15) |
| `POST /resolve {url}` | metadata for a link |
| `POST /stream {url}` | direct audio link (`url`, `mimeType?`, `expiresAt?`, `httpHeaders?`, `track`); `422` for segmented sources |

Load safeguards: cap on concurrent yt-dlp runs (`MAX_CONCURRENT_RESOLVES`) with a bounded wait queue, `503` + `Retry-After` when full, per-token rate limit on `/search` and `/stream` (`RESOLVE_RATE_LIMIT_MAX`), in-memory link cache (`STREAM_CACHE_TTL`) with de-duplication of identical in-flight resolves.

## Risks

| Risk | Mitigation |
|---|---|
| Downloading may violate source ToS (YouTube and others) and copyright | Self-hosted, off by default, README disclaimer, prefer own/CC/public-domain content, no sharing downloaded audio |
| iTunes art terms limit use to promoting store content (grey area) | Personal self-hosted tool; can fall back to source thumbnails |
| Deezer API terms unverified | Review before any wider distribution |
| yt-dlp breaks when sites change | Kept current with `pipx upgrade yt-dlp` (update procedure below) |
| Store policy | Keep the downloader out of store builds |
| SSRF / DNS rebinding | URL guard blocks private and reserved addresses; rebinding not fully covered (v2 hardening) |
| Token in plain text on device; sent on every request | Use HTTPS; secure storage in v2 |
| Plain-HTTP LAN mode sends the token unencrypted | Opt-in (LAN address as `PUBLIC_URL`), trusted home network only, port allowed only from the LAN in the firewall and never port-forwarded; HTTPS everywhere else |
| Stream links tied to the server's public IP and expiring | Works on the server's network only; proxy out of scope (would bring back bandwidth load) |
| Save queue lost on restart | App resumes `saving/failed` on startup (planned); server holds no jobs |

## Ops

- **Update yt-dlp:** run `pipx upgrade yt-dlp` (or `pipx install --force yt-dlp`) and restart the server. Do this first when searching or streaming starts failing.
- **Age-restricted videos:** anonymous yt-dlp fails with "Sign in to confirm your age"; `YTDLP_COOKIES_FILE` (optional, unset by default) points at a Netscape cookies.txt on the host from a signed-in account, and the banner reports whether it loaded (see the server README).
- **Storage:** the server stores no audio; saved files live in the app's storage on the device.
- **Limits:** resolve concurrency, link cache TTL, rate limits and CORS are env-configurable.
- **Exposure:** keep the port off the internet and publish through a tunnel; set `TRUST_PROXY=true` behind it. For home-LAN use allow the port only from the LAN in the firewall (the server binds `0.0.0.0` by default) and never port-forward it.
