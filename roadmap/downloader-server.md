# Downloader server

Optional self-hosted server (`apps/server`) that lets the app search and download audio. Built in v1 as M3.5 ([v1-frontend.md](v1-frontend.md)); multi-user and hardening are v2 ([v2-backend.md](v2-backend.md)). Not tested on a device yet. Run instructions, env vars and full API detail: [apps/server/README.md](../apps/server/README.md).

## Architecture

- **Server:** Node + Fastify, yt-dlp and ffmpeg, Docker image with a pinned yt-dlp. Single user, one shared bearer token (`OPEN_RECORD_TOKEN`). Imports only `@open-record/models`.
- **Client:** `libs/providers/remote` implements `MusicSourceProvider` over HTTP (CapacitorHttp on native, fetch on web). The finished file goes through the local import pipeline and becomes a normal `local:` track with embedded tags and art.
- **App UI:** Settings > Download server (URL, token, Test connection); Search > Download sources (source chips, paste a link); a downloads queue in `LibraryStore` (queued, downloading, done, failed, retry). The queue is not persisted across restarts.
- **Flow:** search or paste link, `POST /downloads`, poll job, `GET /downloads/:id/file`, save to app storage, play offline.
- **Transport:** HTTPS (Tailscale or Cloudflare tunnel) is recommended. Plain HTTP on the home LAN is supported (decision): Android allows cleartext via `res/xml/network_security_config.xml` (base-config, since domain-config cannot match private IP ranges); iOS sets `NSAllowsLocalNetworking` plus `NSLocalNetworkUsageDescription`. Native requests use CapacitorHttp and `Filesystem.downloadFile` (system HTTP stack), so WebView mixed-content rules do not apply. Compose publishes on `BIND_ADDRESS` (default `127.0.0.1`).

## Sources

| Kind | Sources |
|---|---|
| Search + download | YouTube, YouTube Music, SoundCloud |
| Pasted link only (no yt-dlp search) | Bandcamp, Audiomack, Mixcloud, any yt-dlp-supported site |
| Metadata only (DRM, not downloadable) | Deezer, Spotify, Apple Music, Tidal |

## Metadata

iTunes Search API and Deezer public API are queried in parallel, candidates scored on title, artist and duration, and a confident match gives title, artist, album, year, genre and hi-res art (iTunes 1000x1000, Deezer `cover_xl`). The server embeds tags and cover into the file. No confident match or a lookup failure keeps yt-dlp's own metadata and never fails the job. MusicBrainz and Cover Art Archive are fully removed.

## API

All need `Authorization: Bearer <token>` except `/health`.

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /search?q&source` | search youtube, ytmusic, soundcloud (max 15) |
| `POST /resolve {url}` | metadata for a link |
| `POST /downloads {url}` | create job (`202`, `429` if queue full) |
| `GET /downloads/:id` | status, progress, track metadata |
| `GET /downloads/:id/file` | audio stream, supports `Range` |
| `GET /metadata?title&artist&durationSec` | iTunes + Deezer lookup |

## Risks

| Risk | Mitigation |
|---|---|
| Downloading may violate source ToS (YouTube and others) and copyright | Self-hosted, off by default, README disclaimer, prefer own/CC/public-domain content, no sharing downloaded audio |
| iTunes art terms limit use to promoting store content (grey area) | Personal self-hosted tool; can fall back to source thumbnails |
| Deezer API terms unverified | Review before any wider distribution |
| yt-dlp breaks when sites change | Pinned version, update procedure below |
| Store policy | Keep the downloader out of store builds |
| SSRF / DNS rebinding | URL guard blocks private and reserved addresses; rebinding not fully covered (v2 hardening) |
| Token in plain text on device; sent on every request | Use HTTPS; secure storage in v2 |
| Plain-HTTP LAN mode sends the token unencrypted | Opt-in (`BIND_ADDRESS`), trusted home network only, never port-forwarded; HTTPS everywhere else |
| Queue lost on restart (app and server) | Persisted queue in v2 |

## Ops

- **Update yt-dlp:** find the latest version at pypi.org/project/yt-dlp, rebuild with `YTDLP_VERSION=<version> docker compose -f apps/server/docker-compose.yml up -d --build`, then bump the default in `apps/server/Dockerfile` and `docker-compose.yml`. Do this first when downloads start failing.
- **Storage:** files live in the `open-record-data` volume and are deleted after `DOWNLOAD_TTL_HOURS` (default 24).
- **Limits:** concurrency, timeout, rate limit and CORS are env-configurable.
- **Exposure:** keep the port on `127.0.0.1` and publish through a tunnel; set `TRUST_PROXY=true` behind it. For home-LAN use set `BIND_ADDRESS` to the LAN IP (or `0.0.0.0`), allow the port only from the LAN in the firewall and never port-forward it.
