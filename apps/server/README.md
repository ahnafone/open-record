# Open Record download server

A small self-hosted HTTP server (Node 24 + Fastify) that the Open Record app
talks to for searching and downloading audio with
[yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg. It is single-user and
protected by one shared bearer token.

> **Disclaimer.** Downloading from YouTube and many other sites breaks their
> terms of service and may be illegal where you live, depending on the content.
> This server is for personal use with content you have the right to download
> (your own uploads, public-domain or Creative Commons material, or where the
> rights holder allows it). You run it on your own hardware and you are
> responsible for how you use it. It is not part of the app-store builds.

## Run with Docker (recommended)

The image contains Node 24, a pinned yt-dlp and ffmpeg, and runs as a
non-root user. Run from the repository root:

```sh
export OPEN_RECORD_TOKEN=$(openssl rand -hex 32)   # keep this; the app needs it
docker compose -f apps/server/docker-compose.yml up -d --build
curl http://127.0.0.1:8787/health                    # {"status":"ok"}
```

You can also put the variables in `apps/server/.env` (copy `.env.example`);
compose reads it automatically.

Downloads are kept in the `open-record-data` Docker volume (`/data` in the
container). The compose file publishes the port on `127.0.0.1` by default; set
`BIND_ADDRESS` to use it from other devices on your home network (see
[Plain HTTP on your home LAN](#plain-http-on-your-home-lan)).

## Run without Docker (development)

Needs Node 24, plus `yt-dlp` and `ffmpeg` on `PATH` for the download features.

```sh
npm install
cp apps/server/.env.example apps/server/.env   # then set OPEN_RECORD_TOKEN
npx nx serve server                            # builds, then runs dist/apps/server/main.mjs
```

Other targets: `npx nx run-many -t lint,typecheck,build,test --projects=server`.

## Environment variables

| Variable            | Default      | Notes                                                                 |
| ------------------- | ------------ | --------------------------------------------------------------------- |
| `OPEN_RECORD_TOKEN` | (required)   | Shared bearer token, at least 16 characters. Server refuses to start without it. |
| `PORT`              | `8787`       | Listen port.                                                          |
| `HOST`              | `0.0.0.0`    | Listen interface.                                                     |
| `BIND_ADDRESS`      | `127.0.0.1`  | Docker compose only: host address the port is published on. Set to the LAN IP or `0.0.0.0` for home-LAN use. |
| `DATA_DIR`          | `./data`     | Where downloads and job state go (`/data` in Docker).                 |
| `CORS_ORIGINS`      | (any origin) | Comma-separated allow-list, e.g. `capacitor://localhost,http://localhost`. |
| `RATE_LIMIT_MAX`    | `120`        | Requests per minute per client IP.                                    |
| `TRUST_PROXY`       | `false`      | Set `true` behind a reverse proxy/tunnel so rate limits use the real client IP. |
| `LOG_LEVEL`         | `info`       | Fastify/pino log level.                                               |
| `DOWNLOAD_CONCURRENCY` | `2`       | yt-dlp downloads that run at once (1-16); the rest wait in a queue (max 100). |
| `DOWNLOAD_TIMEOUT_SEC` | `900`     | A download running longer than this is killed and marked failed.      |
| `DOWNLOAD_TTL_HOURS` | `24`        | Finished jobs and their files are deleted after this; swept every 15 min. |
| `YTDLP_PATH`        | `yt-dlp`     | yt-dlp binary to run.                                                 |
| `FFMPEG_PATH`       | `ffmpeg`     | ffmpeg binary used for tagging (defaults to the one on `PATH`).       |

Every request needs `Authorization: Bearer <OPEN_RECORD_TOKEN>`, except
`GET /health`.

## Metadata lookup

`GET /metadata?title=&artist=&durationSec=` (auth required) looks a track up on
the iTunes Search API and Deezer's public API in parallel and returns the best
confident match, or `null`:

```json
{ "match": { "title": "Midnight City", "artist": "M83", "album": "Hurry Up, We're Dreaming",
  "year": 2011, "genre": "Electronic", "artworkUrl": "https://is1-ssl.mzstatic.com/.../1000x1000bb.jpg",
  "durationSec": 241, "source": "itunes" } }
```

- `title` is required (max 300 chars); `artist` and `durationSec` improve accuracy.
  Upload noise such as `(Official Video)`, `[Lyrics]`, `feat. X`, `- Topic`,
  `VEVO` and an `Artist - Title` prefix is stripped before searching.
- Candidates are scored on title and artist similarity and duration (within a
  few seconds; more than 20s apart is rejected). Below the threshold the answer
  is `null` rather than a wrong match. Art is 1000x1000 (iTunes) or Deezer `cover_xl`.
- One provider failing is tolerated; both failing returns `502`. Results are
  cached in memory (24h for matches, 1h for misses).
- `services/metadata` also exports `enrichFile(path, {title, artist, durationSec})`,
  which looks the track up and rewrites the file's title/artist/album/date/genre
  tags with ffmpeg, embedding the cover (m4a/mp4/mp3/flac). Artwork is fetched
  over HTTPS from the iTunes/Deezer image CDNs only, size-capped at 8 MB.
- iTunes' terms restrict artwork to promoting store content, and Deezer's API
  terms are unverified; this is a personal, self-hosted tool.

## API

All endpoints take and return JSON and need the bearer token. Errors are
`{"error": "..."}` with a 4xx/5xx status.

```ts
SearchResult = { id, title, artist, durationSec?: number, thumbnailUrl?: string, url: string, site: string }
```

| Endpoint | Body / query | Response |
| --- | --- | --- |
| `GET /search?q=&source=` | `source`: `youtube` (default), `ytmusic`, `soundcloud`, `bandcamp`, `audiomack`, `mixcloud`; `q` max 200 chars | `{ results: SearchResult[] }` (max 15) |
| `POST /resolve` | `{ url }` | `SearchResult` (metadata only, `yt-dlp -J --no-playlist`) |
| `POST /downloads` | `{ url }` | `202 { id, status }`; `429` when the queue is full |
| `GET /downloads/:id` | | `{ id, status, progress, error?, track? }` |
| `GET /downloads/:id/file` | optional `Range` | audio stream (`206` for ranges), `404` until `status` is `done` |

- `status` is `queued`, `downloading`, `processing` (ffmpeg / tagging), `done`
  or `failed`. `progress` is 0-100 (it stays at 99 or below until `done`).
- `track` is `{ title, artist, album?, year?, genre?, durationSec?, artworkUrl? }`
  from yt-dlp's metadata. During `processing` the server looks the track up
  (see Metadata lookup); on a confident match the file is re-tagged with the
  cover and `track` takes the match's title/artist/album/year/genre/artwork.
  A miss or lookup error keeps yt-dlp's metadata and never fails the job.
- **Search limits.** yt-dlp has no search for Bandcamp, Audiomack or Mixcloud,
  so those sources return `400`; paste a track link into `/resolve` or
  `/downloads` instead. `ytmusic` searches the Songs shelf of
  `music.youtube.com/search`; for speed it returns flat results, so `artist`
  and `durationSec` are usually empty there (the download fills them in).
- Downloads are audio only: best m4a stream (or converted to m4a with ffmpeg),
  with tags and cover embedded. Playlists and live streams are refused, files
  over 500 MB are skipped.
- Jobs are kept in memory. Files live in `DATA_DIR/downloads/<id>/` and are
  deleted after `DOWNLOAD_TTL_HOURS`; leftovers from a previous run are removed
  on start.

### Safety

- yt-dlp is started with an argument array (never a shell), with
  `--ignore-config`, `--no-playlist` and `--` before the URL.
- URLs must be `http`/`https`, at most 2048 characters, with no credentials.
  The hostname is resolved and refused if any address is private, loopback,
  link-local (including cloud metadata `169.254.169.254`), CGNAT, multicast or
  reserved. yt-dlp resolves and follows redirects itself, so this does not stop
  DNS rebinding; keep the server off networks with sensitive internal services
  if that matters to you.
- `services/downloads.ts` exports `setPostProcess(hook)`: an async
  `(job, filePath, info)` hook run after yt-dlp and before the job is `done`
  (no-op by default). `main.ts` registers the metadata hook from
  `services/download-metadata.ts`; `buildApp` (and so the tests) does not.

## Reaching it from your phone

### Plain HTTP on your home LAN

The app accepts plain `http://` server URLs on Android (cleartext is allowed
by the app's network security config) and on iOS for local-network hosts
(`NSAllowsLocalNetworking`; iOS asks for Local Network permission the first
time). To use the server from your phone on the same Wi-Fi:

```sh
BIND_ADDRESS=192.168.1.20 docker compose -f apps/server/docker-compose.yml up -d --build   # your machine's LAN IP
# or BIND_ADDRESS=0.0.0.0 to listen on every interface
```

Then enter `http://192.168.1.20:8787` and the token in the app under Settings,
Download server.

Caveats:

- **Unencrypted.** Every request carries the bearer token in clear text.
  Anyone on the same network (guests, a compromised device, shared or public
  Wi-Fi) can read it and use your server. Only do this on a home network you
  trust, and rotate the token if in doubt. Use HTTPS (below) everywhere else.
- **Never port-forward it.** Do not forward 8787 on your router or expose it
  to the internet.
- **Firewall.** The host firewall may block the port. Allow it only from your
  LAN, e.g. `sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp`.
  Note that Docker-published ports bypass `ufw` rules on many Linux setups, so
  prefer binding to the LAN IP over `0.0.0.0`.
- **Stable address.** Give the server a DHCP reservation so its IP does not
  change.
- Leave `TRUST_PROXY=false` (no proxy in front).
- The browser build of the app cannot use an `http://` server from an
  `https://` page (mixed content); the Android/iOS apps use native HTTP and
  are not affected.

### HTTPS (recommended, required outside your home)

Do not expose the plain HTTP port to the internet. The token travels in every
request, so it must be encrypted. Put the server behind an HTTPS tunnel:

- **Tailscale** (private): install Tailscale on the server and phone, then
  `tailscale serve --bg 8787` gives you `https://<machine>.<tailnet>.ts.net`.
- **Cloudflare Tunnel** (public URL):
  `cloudflared tunnel --url http://127.0.0.1:8787`, or a named tunnel with
  Cloudflare Access in front.

Set `TRUST_PROXY=true` when running behind either. Enter the HTTPS URL and the
token in the app under Settings, Download server.

## Updating yt-dlp

Sites change often and yt-dlp releases fixes quickly. The version is pinned in
the image so builds are reproducible. To update:

1. Find the latest version at <https://pypi.org/project/yt-dlp/#history>.
2. Rebuild with it:

   ```sh
   YTDLP_VERSION=2026.10.21 docker compose -f apps/server/docker-compose.yml up -d --build
   ```

3. Once it works, bump the default `YTDLP_VERSION` in `apps/server/Dockerfile`
   and `apps/server/docker-compose.yml`.

The image installs `yt-dlp[default]`, which includes the YouTube JS challenge
solver; Node in the image can serve as its JavaScript runtime
(`--js-runtimes node`).

## Code layout

```
src/
  main.ts          entry: loads config, creates DATA_DIR, listens
  app.ts           buildApp(): CORS, rate limit, auth hook, then route plugins
  config.ts        env parsing and validation
  plugins/auth.ts  bearer-token onRequest hook (constant-time compare)
  routes/          one Fastify plugin per feature; register it in routes/index.ts
    search.ts      GET /search, POST /resolve
    downloads.ts   POST /downloads, GET /downloads/:id[/file]
  services/        non-HTTP logic used by routes
    ytdlp.ts       yt-dlp runner, search targets, result mapping
    downloads.ts   job queue, progress parsing, cleanup, postProcess hook
    url-guard.ts   URL validation / SSRF guard
    download-metadata.ts  postProcess hook: enrichFile + update job.track
  services/metadata/  iTunes + Deezer lookup, scoring, cache, ffmpeg tagging
```

Routes are authenticated by default. To make one public, set
`config: { public: true }` on it. The server may import only `type:models`
libraries (`@open-record/models`); the lint rule enforces this.
