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

## Quick start

From the repository root:

```sh
npm run server:up
```

This detects your LAN IP, builds the web app (`nx build app`) and the server,
starts the server detached on this machine, then prints one link,
`http://<lan-ip>:8787/` — the server serves the web app and the API on the same
origin — plus the startup banner and a pairing QR code, and exits. Open it in a
browser, or in the phone app open **Settings > Stream server > Scan QR code**
(or type the address); the app stores only the address, then sign in.

The token is generated on first start and saved in
`~/.config/open-record/token` (mode 0600), so it stays the same across
restarts. Set `OPEN_RECORD_TOKEN` if you prefer your own token. It is shown in
the terminal and the QR code; anyone with it can use the server.

## Prerequisites

- **Node 24** on `PATH` (`node --version`). The machine this was set up on uses
  nvm.
- **yt-dlp**, installed with `pipx install yt-dlp`. It lands at
  `~/.local/bin/yt-dlp`, which shadows the older distro copy at
  `/usr/bin/yt-dlp`; keep `~/.local/bin` ahead of `/usr/bin` in `PATH`.
- **ffmpeg 6+**, optional: needed by the planned casting work. The distro
  package (`sudo apt install ffmpeg`, 6.1.1) satisfies it and resolves as
  `/usr/bin/ffmpeg`.

Then `npm install` once in the repository root.

## Run on this machine

```sh
npm run server:up                   # detect the LAN IP, build, start detached, print banner + QR, exit
npm run server:up -- --ip 10.0.0.5  # choose the LAN address
npm run server:up -- --host 127.0.0.1
                                    # bind this address instead (e.g. behind a tunnel)
npm run server:up -- --follow       # stay attached and stream the server output
npm run server:up -- --stop         # stop the detached server
npm run server:start                # alias for server:up
npm run server:stop                 # alias for server:up --stop
npm run server:dev                  # npx nx serve server (foreground, development)
```

`server:up` keeps its state in `~/.config/open-record/`, created mode 0700: the
`token` (0600), plus `server.pid` and `server.log` for the detached process
(`--stop` uses the pid file; the log collects the output while detached and
holds the banner, so it is 0600 too). `OPEN_RECORD_DATA_DIR` moves them
elsewhere. The token never changes across restarts unless the file is deleted
or `OPEN_RECORD_TOKEN` is set.

`PORT`, `PUBLIC_URL` and `OPEN_RECORD_DATA_DIR` are read from the environment or
from `apps/server/.env`, so the address the script prints and probes is the one
the server really uses. `PUBLIC_URL`, when set, is used verbatim (that is what
the banner and QR show); otherwise the printed address comes from `--host`, then
`--ip`, then `HOST` in that file, then the detected LAN address. The script reads
nothing else from the file; the server reads all of it.

The banner (URL, token, QR code) is printed as soon as the server listens.
Optionally copy `apps/server/.env.example` to `apps/server/.env` to set
variables.

`server:dev` is the development path: it builds and runs
`dist/apps/server/main.mjs` in the foreground, with logs going to the terminal.
Other targets: `npx nx run-many -t lint,typecheck,build,test --projects=server`.

## Run as a systemd user service

On a machine that should keep the server up, use the user unit in
`deploy/open-record-server.service` instead of `server:up`; both bind port
8787, so run one or the other. From the repository root:

```sh
mkdir -p ~/.config/systemd/user
ln -sf "$PWD/deploy/open-record-server.service" ~/.config/systemd/user/
loginctl enable-linger $USER
systemctl --user daemon-reload
systemctl --user enable --now open-record-server
journalctl --user -u open-record-server -f
```

The symlink is required: `systemctl --user` only scans `~/.config/systemd/user`,
`/etc/systemd/user` and `/usr/lib/systemd/user`, never this repository.

The unit assumes the repository is at `~/Github/open-record` (`%h` is your home
directory) and runs:

```sh
~/.local/bin/node --env-file-if-exists=%h/Github/open-record/apps/server/.env \
  %h/Github/open-record/dist/apps/server/main.mjs
```

with `WorkingDirectory` at the repository root, `WEB_DIR` at
`dist/apps/app/browser` and `PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`.
Build both first (`npx nx build app`, `npx nx build server`), then reload and
start.

It starts `~/.local/bin/node`, a symlink to the nvm-managed Node; after an nvm
upgrade, repoint it:

```sh
ln -sf "$(command -v node)" ~/.local/bin/node
```

The unit binds `HOST=0.0.0.0` by default, so firewall the port:
`sudo ufw allow from <your-subnet> to any port 8787 proto tcp`. This is an
ordinary host process, so `ufw` rules apply to it.

## Environment variables

Values come from `apps/server/.env` (copy `.env.example`), read with
`node --env-file-if-exists` by `server:up` and by the systemd unit alike.
Variables the unit sets itself (`WEB_DIR`, `PATH`, `NODE_ENV`) win over the
same names in `.env`: Node's env-file loading never overrides a variable that
is already set.

| Variable            | Default      | Notes                                                                 |
| ------------------- | ------------ | --------------------------------------------------------------------- |
| `OPEN_RECORD_TOKEN` | (generated)  | Shared bearer token, at least 16 characters. When unset, a random token is generated once and saved to `<OPEN_RECORD_DATA_DIR>/token` (mode 0600) and reused on restart. |
| `OPEN_RECORD_DATA_DIR` | `~/.config/open-record` | Where the generated token is stored, with `server.pid` and `server.log` while started with `server:up`. Absolute path: `~` is not expanded. |
| `PUBLIC_URL`        | (detected)   | URL phones use, shown in the banner and QR code, used verbatim. `npm run server:up` sets it to the LAN IP. |
| `PORT`              | `8787`       | Listen port.                                                          |
| `HOST`              | `0.0.0.0`    | Listen interface. `npm run server:up` uses `--host`, then `--ip`, then this value, then the detected LAN address; the systemd unit leaves the default. |
| `MAX_CONCURRENT_RESOLVES` | `2`  | yt-dlp processes (search, resolve, stream) that run at once (1-16). Extra calls wait in a short queue; when it is full the server answers `503` with `Retry-After`. |
| `STREAM_CACHE_TTL`  | `1800`       | Seconds a resolved stream link is cached in memory (0 disables). A cached link is never served past its own expiry. |
| `RESOLVE_RATE_LIMIT_MAX` | `30`    | Requests per minute per token on `/search` and `/stream` (stricter than `RATE_LIMIT_MAX`). |
| `SUPABASE_JWT_SECRET` | (unset) | Optional. Also accept signed-in users' Supabase access tokens (HS256, shared-secret projects; at least 32 characters). Local stack: "JWT secret" from `supabase status`. |
| `SUPABASE_URL`      | (unset)      | Optional. Verifies asymmetric (ES256/RS256) Supabase tokens via `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, and is served at `GET /app-config` when `SUPABASE_ANON_KEY` is set. Must be `http(s)`. |
| `SUPABASE_ANON_KEY` | (unset)      | Optional, public. With `SUPABASE_URL`, served at `GET /app-config` so the web app can sign in. Setting it without `SUPABASE_URL` is a startup error. |
| `WEB_DIR`           | (unset)      | Optional. Host path of a built web app (`dist/apps/app/browser`) served at `/` without a token, with SPA fallback to `index.html` for HTML GETs. API routes keep their auth and are never shadowed. Unset (or no `index.html`) = API only. |
| `YTDLP_PATH`        | `yt-dlp`     | yt-dlp binary to run.                                                 |
| `YTDLP_COOKIES_FILE` | `<data dir>/cookies.txt` when present | Optional Netscape `cookies.txt` on this machine, e.g. `/home/you/cookies.txt`. Every request goes out without cookies first; only a video refused for sign-in (age gate, private, members-only, bot check) is retried once with them, so those songs take two yt-dlp runs. When unset, `<OPEN_RECORD_DATA_DIR>/cookies.txt` is used if that file exists; when neither exists the server has no cookies at all (no warning). An explicit path always wins, even when it is broken. A path that is unreadable, empty or not a Netscape file only logs a warning and a banner note; it never stops the server, and requests run anonymously. See [Age-restricted videos (cookies)](#age-restricted-videos-cookies). |

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
| `GET /health` | | `{ status: "ok" }` (no auth; liveness check) |
| `GET /app-config` | | `{ supabaseUrl: string \| null, supabaseAnonKey: string \| null }` (no auth, `cache-control: no-store`); both null unless `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set |
| `GET /ping` | | `{ status: "ok" }`; the app's "Test connection" uses it to check the token |
| `GET /search?q=&source=` | `source`: `youtube` (default), `ytmusic`, `soundcloud`, `bandcamp`, `audiomack`, `mixcloud`; `q` max 200 chars | `{ results: SearchResult[] }` (max 15) |
| `POST /resolve` | `{ url }` | `SearchResult` (metadata only, `yt-dlp -J --no-playlist`) |
| `POST /stream` | `{ url, quality? }` | `StreamResponse` (`yt-dlp -J --no-playlist -f bestaudio[ext=m4a]/bestaudio/best` by default). Optional `quality` picks a lower-bitrate format (Highest, High ~160, Medium ~128, Low ~64 kbps); an invalid value returns `400`. Untested on device. |
| `POST /playlist` | `{ url }`: a public or unlisted `youtube.com/playlist?list=`, `youtube.com/watch?v=…&list=`, `music.youtube.com/playlist?list=` or `music.youtube.com/browse/VL…` link, or a single song link: `youtube.com/watch?v=…`, `music.youtube.com/watch?v=…` or `youtu.be/…` (no `list=`; the 11-character id is validated) | `RemotePlaylist` `{ id, title, url, site, uploader?, entries, unavailable, truncated, single? }`. Playlists: `yt-dlp -J --flat-playlist`, first 500 entries. Song links: `yt-dlp -J --no-playlist` on a canonical watch URL, one entry, `single: true`. Each entry: `{ id, url, site, title, artist, originalTitle, uploader?, durationSec?, thumbnailUrl? }`. Private playlists or songs return `403`, missing ones `404`, anything else on the allow-list `400`. An age-gated song returns `422` with the cookie guidance in the body (see [Age-restricted videos](#age-restricted-videos-cookies)). Metadata only: nothing is downloaded. |
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

Each request is one short yt-dlp run (two when a refused video is retried with
cookies), so the server bounds how many run at once:

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

`npm run server:up` does this for you: it picks the LAN IP and starts the
server there. To choose the address yourself, pass it with `--ip`
(`npm run server:up -- --ip 192.168.1.20`).

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
  The server is an ordinary host process, so `ufw` filters the port.
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

The tunnel dials `127.0.0.1`, but `npm run server:up` binds the LAN address by
default. Start it with `--host 127.0.0.1` for a tunnel (the systemd unit
already binds `0.0.0.0`, so it needs no change).

Set `TRUST_PROXY=true` and `PUBLIC_URL` to the HTTPS URL when running behind
either, so the banner and QR code show it. Scan the QR code (or enter the URL)
in the app under Settings, Stream server.

## Updating yt-dlp

Sites change often and yt-dlp releases fixes quickly. There is no pinned
version here: the server runs whatever `yt-dlp` is installed, so update the
host tool. To update:

```sh
pipx upgrade yt-dlp            # or: pipx install --force yt-dlp
```

Then restart the server (`npm run server:up -- --stop` followed by
`npm run server:up`, or `systemctl --user restart open-record-server`). If you
need a specific build or a second copy, set `YTDLP_PATH` in
`apps/server/.env` to its path.

`pipx` installs `yt-dlp[default]`, which brings the dependencies for YouTube's
JS challenges; the Node 24 on `PATH` serves as its JavaScript runtime
(`--js-runtimes node`). The EJS challenge solver is **not** bundled: it is a
remote component that yt-dlp fetches from GitHub on first use (see
[Age-restricted videos](#age-restricted-videos-cookies)), which is why the
signed-in retry passes `--remote-components ejs:github`.

## Age-restricted videos (cookies)

Age-restricted YouTube videos (and some bot checks) need a signed-in session:
run anonymously, yt-dlp fails with `ERROR: [youtube] <id>: Sign in to confirm
your age` and the app shows the song as **Age-restricted** on the Failed
downloads page. The server can hand yt-dlp a Netscape-format `cookies.txt` for
those cases; it is optional and everything else keeps working without it.

Every request goes out **without** cookies first. Only when yt-dlp refuses a
video for a sign-in reason (age gate, private, members-only, bot check) and a
usable jar is configured is the same request retried **once** with the cookies.
The common case stays as fast as before; age- and private songs take two yt-dlp
runs, so they are slower (up to about twice the wait).

That signed-in retry also enables yt-dlp's EJS challenge solver with
`--remote-components ejs:github`. Without it, a valid signed-in jar still fails
age-gated YouTube videos (no formats, or "only available on YouTube"). yt-dlp
downloads the solver from GitHub on first use and caches it under its own cache
directory (by default `~/.cache/yt-dlp`), so the first such run needs network
access to GitHub, and the installed yt-dlp must support the flag (verified on
2026.10.26; update with `pipx upgrade yt-dlp`). The solver is used only on the
cookie retry; anonymous requests are unchanged.

1. In a browser signed in to youtube.com with an **age-verified** account,
   export the cookies for youtube.com in Netscape format, e.g. with the
   "Get cookies.txt LOCALLY" extension. Keep the `.txt` file. The server
   prepends the Netscape header when an exporter omits it, but the file must
   still contain Netscape data rows.
2. Put it on this machine somewhere the server can read. The simplest place is
   the data directory: `~/.config/open-record/cookies.txt`, i.e.
   `<OPEN_RECORD_DATA_DIR>/cookies.txt`, which needs no configuration at all —
   the server picks it up automatically when it exists. For another location,
   set `YTDLP_COOKIES_FILE` to that absolute path in `apps/server/.env` (or the
   environment), e.g. `YTDLP_COOKIES_FILE=/home/you/cookies.txt`; an explicit
   path always wins over the data-directory file. The server runs as you, so
   the file only needs to be readable by your user; keep it out of the
   repository (`.gitignore` covers `apps/server/cookies.txt` and any
   `cookies.txt` inside it).
3. The banner shows `Cookies:  <path>  (only when a video needs sign-in)` when
   the jar in use is usable. An **explicit** `YTDLP_COOKIES_FILE` that is
   missing, unreadable, empty, or not a Netscape `cookies.txt` logs a warning
   and the banner warns with the reason; requests still run anonymously and
   the server still starts. The data-directory default is optional: when
   `<OPEN_RECORD_DATA_DIR>/cookies.txt` does not exist it is skipped silently —
   no banner line and no warning.
4. In the app, click Retry (or Retry all) on the Failed downloads page. Each
   yt-dlp run that needs cookies gets a fresh writable copy of the file in its
   own temporary directory, deleted when the run ends (yt-dlp rewrites its
   jar; copies left by a crash are removed at the next start). The file in use
   is re-read on every request, so replacing its **contents** takes effect
   immediately. The data-directory file is only consulted while no explicit
   path is set, so dropping it in or deleting it is picked up without a
   restart. A restart is only needed when the **path** changes — i.e. when
   `YTDLP_COOKIES_FILE` is added, changed or removed (start the server with
   `npm run server:up`, or `systemctl --user restart open-record-server`).
5. YouTube signs sessions out eventually. When age-restricted songs start
   failing again, export a fresh `cookies.txt` and replace the file (no
   restart needed). A song that still hits the age gate with cookies in use
   says the cookies "may be stale", which is the cue to re-export.

Caveats:

- The file holds **live account session tokens**. Treat it like a password:
  never commit it or share it. `.gitignore` covers `apps/server/cookies.txt` and
  any `cookies.txt` inside the repository; keep a copy outside the repository
  and nothing can commit it.
- Using cookies from a server or datacenter IP can get the Google account
  flagged or blocked. Prefer a throwaway account you do not care about.
- Cookies stay on the server: the app only ever receives the CDN audio link,
  and `/stream` still forwards only `User-Agent`, `Referer` and `Origin`.
- Delete the file to stop using cookies on the next request: everything except
  age-restricted videos keeps working. Unsetting `YTDLP_COOKIES_FILE` also
  stops using an explicit jar, but only after a restart (the path is read at
  startup).

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
