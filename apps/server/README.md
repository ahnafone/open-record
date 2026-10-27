# Open Record stream-link server

A small self-hosted HTTP server (Node 24 + Fastify) that the Open Record app
talks to for searching audio and finding a direct link to it, using
[yt-dlp](https://github.com/yt-dlp/yt-dlp). The server never downloads,
transcodes or proxies audio: it returns a link and the phone fetches the bytes
straight from the source. It is single-user and protected by one shared bearer
token.

> **Disclaimer.** Streaming or downloading from YouTube and many other sites breaks their
> terms of service and may be illegal where you live, depending on the content.
> This server is for personal use with content you have the right to download
> (your own uploads, public-domain or Creative Commons material, or where the
> rights holder allows it). You run it on your own hardware and you are
> responsible for how you use it. It is not part of the app-store builds.

## Quick start (recommended)

From the repository root:

```sh
npm run server:up
```

This detects your LAN IP, builds the web app (`nx build app`), builds and
starts the server in Docker, and prints one link, `http://<lan-ip>:8787/`: the image serves the web app
and the API on the same origin. Open it in a browser, or in the phone app open **Settings > Stream
server > Scan QR code** (or type the address); the app stores only the address, then sign in. Use `npm run server:up -- --ip 192.168.1.20`
to choose the address yourself.

The token is generated on first start and saved in the `server-data` Docker
volume, so it stays the same across restarts. Set `OPEN_RECORD_TOKEN` yourself
if you prefer your own token. The token is shown in the terminal and the QR
code; anyone with it can use the server.

## Run with Docker

The image contains Node 24 and a pinned yt-dlp, and runs as a non-root user.
Run from the repository root:

```sh
npx nx build app                                               # web app, copied into the image
docker compose -f apps/server/docker-compose.yml up -d --build
docker compose -f apps/server/docker-compose.yml logs server   # banner: URL, QR
curl http://127.0.0.1:8787/health                              # {"status":"ok"}
```

Without `PUBLIC_URL` the banner shows the container address, which phones
cannot reach; use `npm run server:up` (or set `PUBLIC_URL`) for LAN use. You
can also put variables in `apps/server/.env` (copy `.env.example`); compose
reads it automatically.

The compose file publishes the port on `127.0.0.1` by default; `npm run server:up`
sets `BIND_ADDRESS` to the LAN IP (see
[Plain HTTP on your home LAN](#plain-http-on-your-home-lan)).

## Run without Docker (development)

Needs Node 24 and `yt-dlp` on `PATH`.

```sh
npm install
npx nx serve server                            # builds, then runs dist/apps/server/main.mjs
```

The startup banner (URL and QR code) is printed as soon
as the server listens. Optionally copy `apps/server/.env.example` to
`apps/server/.env` to set variables.

Other targets: `npx nx run-many -t lint,typecheck,build,test --projects=server`.

## Environment variables

| Variable            | Default      | Notes                                                                 |
| ------------------- | ------------ | --------------------------------------------------------------------- |
| `OPEN_RECORD_TOKEN` | (generated)  | Shared bearer token, at least 16 characters. When unset, a random token is generated once and saved to `<OPEN_RECORD_DATA_DIR>/token` (mode 0600) and reused on restart. |
| `OPEN_RECORD_DATA_DIR` | `~/.config/open-record` | Where the generated token is stored. Docker uses `/data` (the `server-data` volume). |
| `PUBLIC_URL`        | (detected)   | URL phones use, shown in the banner and QR code, used verbatim. `npm run server:up` sets it to the LAN IP. |
| `PORT`              | `8787`       | Listen port.                                                          |
| `HOST`              | `0.0.0.0`    | Listen interface. A specific address limits the banner to that address. |
| `BIND_ADDRESS`      | `127.0.0.1`  | Docker compose only: host address the port is published on. Set to the LAN IP or `0.0.0.0` for home-LAN use. |
| `MAX_CONCURRENT_RESOLVES` | `2`  | yt-dlp processes (search, resolve, stream) that run at once (1-16). Extra calls wait in a short queue; when it is full the server answers `503` with `Retry-After`. |
| `STREAM_CACHE_TTL`  | `1800`       | Seconds a resolved stream link is cached in memory (0 disables). A cached link is never served past its own expiry. |
| `RESOLVE_RATE_LIMIT_MAX` | `30`    | Requests per minute per token on `/search` and `/stream` (stricter than `RATE_LIMIT_MAX`). |
| `SUPABASE_JWT_SECRET` | (unset) | Optional. Also accept signed-in users' Supabase access tokens (HS256, shared-secret projects; at least 32 characters). Local stack: "JWT secret" from `supabase status`. |
| `SUPABASE_URL`      | (unset)      | Optional. Verifies asymmetric (ES256/RS256) Supabase tokens via `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, and is served at `GET /app-config` when `SUPABASE_ANON_KEY` is set. Must be `http(s)`. |
| `SUPABASE_ANON_KEY` | (unset)      | Optional, public. With `SUPABASE_URL`, served at `GET /app-config` so the web app can sign in. Setting it without `SUPABASE_URL` is a startup error. |
| `WEB_DIR`           | (unset)      | Optional. Directory of a built web app (`dist/apps/app/browser`) served at `/` without a token, with SPA fallback to `index.html` for HTML GETs. API routes keep their auth and are never shadowed. Unset (or no `index.html`) = API only. The Docker image sets `/app/web`. |
| `YTDLP_PATH`        | `yt-dlp`     | yt-dlp binary to run.                                                 |

Every request needs `Authorization: Bearer <token>`, except `GET /health`,
`GET /app-config` and, with `WEB_DIR` set, the web app's static files.
The token is `OPEN_RECORD_TOKEN` if set, otherwise the generated one.
With `SUPABASE_JWT_SECRET` or `SUPABASE_URL` set, a valid Supabase access token is accepted in the same header too; the static token keeps working.

## API

All endpoints take and return JSON and need the bearer token, except
`GET /health` and `GET /app-config`. Errors are `{"error": "..."}` with a 4xx/5xx status.

```ts
SearchResult = { id, title, artist, durationSec?: number, thumbnailUrl?: string, url: string, site: string }
StreamResponse = {
  url: string;              // direct audio link on the source's CDN
  mimeType?: string;        // e.g. "audio/mp4" (from the container)
  expiresAt?: string;       // ISO time the link stops working (its `expire` parameter)
  httpHeaders?: { "User-Agent"?, Referer?, Origin? };   // only these three are passed on
  track: { title, artist, album?, durationSec?, thumbnailUrl? };
}
```

| Endpoint | Body / query | Response |
| --- | --- | --- |
| `GET /health` | | `{ status: "ok" }` (no auth; Docker healthcheck) |
| `GET /app-config` | | `{ supabaseUrl: string \| null, supabaseAnonKey: string \| null }` (no auth, `cache-control: no-store`); both null unless `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set |
| `GET /ping` | | `{ status: "ok" }`; the app's "Test connection" uses it to check the token |
| `GET /search?q=&source=` | `source`: `youtube` (default), `ytmusic`, `soundcloud`, `bandcamp`, `audiomack`, `mixcloud`; `q` max 200 chars | `{ results: SearchResult[] }` (max 15) |
| `POST /resolve` | `{ url }` | `SearchResult` (metadata only, `yt-dlp -J --no-playlist`) |
| `POST /stream` | `{ url, quality? }` | `StreamResponse` (`yt-dlp -J --no-playlist -f bestaudio[ext=m4a]/bestaudio/best` by default). Optional `quality` picks a lower-bitrate format (Highest, High ~160, Medium ~128, Low ~64 kbps); an invalid value returns `400`. Untested on device. |
| `POST /playlist` | `{ url }`: a public or unlisted `youtube.com/playlist?list=`, `youtube.com/watch?v=…&list=`, `music.youtube.com/playlist?list=` or `music.youtube.com/browse/VL…` link, or a single song link: `youtube.com/watch?v=…`, `music.youtube.com/watch?v=…` or `youtu.be/…` (no `list=`; the 11-character id is validated) | `RemotePlaylist` `{ id, title, url, site, uploader?, entries, unavailable, truncated, single? }`. Playlists: `yt-dlp -J --flat-playlist`, first 500 entries. Song links: `yt-dlp -J --no-playlist` on a canonical watch URL, one entry, `single: true`. Each entry: `{ id, url, site, title, artist, originalTitle, uploader?, durationSec?, thumbnailUrl? }`. Private playlists or songs return `403`, missing ones `404`, anything else on the allow-list `400`. Metadata only: nothing is downloaded. |
| `POST /meta/enrich` | `{ items: [{ title, artist?, album?, durationSec? }] }`, 1 to 10 items, fields max 300 chars | `{ results: (EnrichMatch \| null)[] }` in item order. `EnrichMatch = { title, artist, album?, year?, genre?, artUrl?, durationSec?, confidence, sources }`; `null` when no catalogue match reaches 0.82 confidence. |

- **`/stream` links are tied to this server.** The source issues them for the
  server's public IP and they expire (usually within hours; `expiresAt` says
  when). Playing or saving a link therefore only works while the phone can
  reach the server from the same public network, e.g. on your home Wi-Fi, and
  not from mobile data elsewhere. The server does not proxy audio, by design.
- Segmented sources (HLS `m3u8`, DASH, or any non-HTTP protocol) return `422`:
  the phone's native player is given a single progressive file only.
- `/search` returns `400` for `bandcamp`, `audiomack` and `mixcloud`, which
  yt-dlp cannot search; paste a link into `/resolve` or `/stream` instead.
  `ytmusic` searches the Songs shelf of `music.youtube.com/search`; for speed
  it returns flat results, so `artist` and `durationSec` are often empty.
- `/resolve` and `/stream` refuse playlists (`400`); use a single track link.
  Only `/playlist` reads playlists, and it returns metadata only.
- **`/meta/enrich`** looks each song up in YT Music (via yt-dlp), iTunes Search,
  Deezer and MusicBrainz in parallel. No API keys are used. Every source has its
  own timeout (6 to 25 s), and a source that fails or times out is skipped, so
  it never fails the batch. Candidates are scored on title, artist, duration and
  version words (live, remix and similar). Fields are merged in the priority
  YT Music > iTunes > Deezer > MusicBrainz, with lower sources filling gaps.
  MusicBrainz calls share one 1 request/second queue with `/meta/aliases` and
  send a descriptive `User-Agent`. Results (including misses) are kept in an
  in-memory LRU cache (2000 entries; hits for 7 days, misses for 6 hours). Only
  the merged match is returned; raw third-party payloads are never stored.

### Load safeguards

Each request is one short yt-dlp run, so the server bounds how many run at once:

- **Concurrency cap.** At most `MAX_CONCURRENT_RESOLVES` yt-dlp processes run at
  a time across `/search`, `/resolve` and `/stream`. Up to 16 further calls wait
  for a slot for at most 20 seconds. A call that cannot get in answers
  `503 Service Unavailable` with `Retry-After: 5`; the app shows "server busy".
- **Timeout.** A yt-dlp run is killed after 45 seconds and answers `504`.
- **Rate limit.** `/search` and `/stream` allow `RESOLVE_RATE_LIMIT_MAX` requests
  per minute per client (`429` beyond that); the client is the Supabase user when signed in, otherwise the static token, on top of the general
  `RATE_LIMIT_MAX` per IP.
- **Link cache.** `/stream` results are cached in memory for `STREAM_CACHE_TTL`
  seconds, keyed by the URL and requested quality, and dropped a minute before the link's `expiresAt`.
  Identical requests that arrive while one is being resolved share that single
  yt-dlp run.

### Safety

- yt-dlp is started with an argument array (never a shell), with
  `--ignore-config`, `--no-playlist` and `--` before the URL.
- URLs must be `http`/`https`, at most 2048 characters, with no credentials.
  The hostname is resolved and refused if any address is private, loopback,
  link-local (including cloud metadata `169.254.169.254`), CGNAT, multicast or
  reserved. yt-dlp resolves and follows redirects itself, so this does not stop
  DNS rebinding; keep the server off networks with sensitive internal services
  if that matters to you.
- `/stream` only forwards `User-Agent`, `Referer` and `Origin` from yt-dlp's
  headers; cookies and everything else are dropped.
- `/playlist` uses a strict allow-list: `http`/`https`, no credentials or port,
  hosts `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`
  and `youtu.be` (short links, songs only) only, and either a well-formed `list`
  id or a well-formed 11-character video id. yt-dlp never sees the link you
  sent: the server rebuilds a canonical URL from the id.
- `/meta/enrich` only calls fixed public API hosts (`itunes.apple.com`,
  `api.deezer.com`, `musicbrainz.org`), never follows redirects, caps response
  size, and accepts `https` artwork links only.

## Reaching it from your phone

### Plain HTTP on your home LAN

The app accepts plain `http://` server URLs on Android (cleartext is allowed
by the app's network security config) and on iOS for local-network hosts
(`NSAllowsLocalNetworking`; iOS asks for Local Network permission the first
time). To use the server from your phone on the same Wi-Fi:

`npm run server:up` does this for you: it picks the LAN IP and publishes the
server there. To choose the address yourself, pass it with `--ip`
(`npm run server:up -- --ip 192.168.1.20`), or start compose manually with
`BIND_ADDRESS=192.168.1.20 PUBLIC_URL=http://192.168.1.20:8787`.

Then scan the QR code in the app under Settings, Stream server (or enter
`http://192.168.1.20:8787` by hand), and sign in.

Caveats:

- **Unencrypted.** Every request carries the bearer token in clear text.
  Anyone on the same network (guests, a compromised device, shared or public
  Wi-Fi) can read it and use your server. Only do this on a home network you
  trust, and rotate the token if in doubt. Use HTTPS (below) everywhere else.
- **Never port-forward it.** Do not forward 8787 on your router or expose it
  to the internet.
- **Firewall.** The host firewall may block the port. `npm run server:up`
  warns when `/health` is unreachable from its own LAN address. Allow the port
  only from your LAN, e.g. `sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp`.
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

Set `TRUST_PROXY=true` and `PUBLIC_URL` to the HTTPS URL when running behind
either, so the banner and QR code show it. Scan the QR code (or enter the URL)
in the app under Settings, Stream server.

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
  main.ts          entry: resolves the token, loads config, listens, prints the banner
  app.ts           buildApp(): CORS, rate limit, auth hook, then route plugins
  config.ts        env parsing and validation
  plugins/auth.ts  bearer-token onRequest hook (constant-time compare)
  plugins/web.ts   serves WEB_DIR at / (public static files, SPA fallback)
  routes/          one Fastify plugin per feature; register it in routes/index.ts
    health.ts      GET /health, GET /app-config (public), GET /ping (authed)
    search.ts      GET /search, POST /resolve
    stream.ts      POST /stream
    playlist.ts    POST /playlist
    meta.ts        GET /meta/aliases, POST /meta/enrich
    errors.ts      service error -> HTTP response (incl. 503 + Retry-After)
  services/        non-HTTP logic used by routes
    ytdlp.ts       yt-dlp runner, search targets, result and stream mapping
    resolve-limiter.ts  concurrency cap and bounded wait queue
    stream-cache.ts     TTL link cache, in-flight de-duplication, token rate-limit key
    url-guard.ts   URL validation / SSRF guard
    playlist.ts    playlist and song link allow-list, flat-playlist and single-song mapping
    enrich.ts      catalogue lookups, scoring, merge and LRU cache
    musicbrainz.ts paced (1 req/s) MusicBrainz client shared by aliases and enrich
    token-store.ts access token from env, <dataDir>/token, or generated (0600)
    network.ts     picks the LAN URL for the banner (PUBLIC_URL, HOST, LAN IPv4)
    banner.ts      startup banner: URL, terminal QR
```

Routes are authenticated by default. To make one public, set
`config: { public: true }` on it. The server may import only `type:models`
libraries (`@open-record/models`); the lint rule enforces this.
