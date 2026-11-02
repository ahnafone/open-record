# Third-party notices — Open Record desktop app

Open Record bundles third-party software with its installers. This file lists
the components, their licenses, and where to obtain their source. It is
provided for attribution and is **not legal advice**; consult the upstream
license texts before redistributing.

The desktop app itself is licensed under the repository's [MIT license](LICENSE).

## Electron

- Component: Electron 45.2.1 (Chromium, V8, Node.js)
- License: MIT (Electron); Chromium is BSD-3-Clause and includes many other
  third-party components.
- Source: <https://github.com/electron/electron>
- License text: <https://github.com/electron/electron/blob/main/LICENSE>
- Chromium third-party licenses are shipped inside the Electron framework
  (`LICENSES.chromium.html`).

## yt-dlp

- Component: yt-dlp 2026.10.26 (`yt-dlp_linux`, `yt-dlp.exe`, `yt-dlp_macos`)
- License: The Unlicense (public domain dedication), with bundled third-party
  Python packages under their own licenses.
- Source: <https://github.com/yt-dlp/yt-dlp>
- Release: <https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26>
- The standalone builds bundle a Python runtime (Python Software Foundation
  License) and Python dependencies. Their license metadata is included in the
  upstream release's `THIRD_PARTY_LICENSES.txt`:
  <https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt>

## FFmpeg

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
Open Record ships a prebuilt `ffmpeg` executable only (not `ffprobe`); the
server uses it for media probing/remuxing.

### Linux x64 and Windows x64 (LGPL build)

- Build: BtbN/FFmpeg-Builds `autobuild-2026-11-01-12-49`, FFmpeg n8.1.3,
  explicit LGPL variant (built without `--enable-gpl`).
- License: LGPL-2.1-or-later.
- Source: <https://github.com/FFmpeg/FFmpeg> (tag `n8.1.3`) and the build
  scripts at <https://github.com/BtbN/FFmpeg-Builds>.
- License text: <https://ffmpeg.org/legal.html> and the `LICENSE` file in the
  build archive.
- Pinned archives:
  - `ffmpeg-n8.1.3-29-gad3b795b72-linux64-lgpl-8.1.tar.xz`
  - `ffmpeg-n8.1.3-29-gad3b795b72-win64-lgpl-8.1.zip`

### macOS arm64 and x64 (ffmpeg-static build)

- Build: ffmpeg-static `b6.1.1` (FFmpeg 6.1.1), assets `ffmpeg-darwin-arm64.gz`
  and `ffmpeg-darwin-x64.gz`.
- Source: <https://github.com/eugeneware/ffmpeg-static>; the binaries are
  collected from <https://evermeet.cx/ffmpeg/> (x64) and
  <https://osxexperts.net/> (arm64).
- FFmpeg's core is LGPL-2.1-or-later, but these third-party macOS builds do not
  publish their configure flags and may include GPL-licensed optional
  components. Treat the macOS binary as **GPL-2.0-or-later** unless upstream
  confirms an LGPL-only configuration. Source code is available from
  <https://ffmpeg.org/download.html> and the build scripts linked above.
- Because FFmpeg is statically linked into a single executable, redistributors
  of the macOS build should also make the corresponding FFmpeg source
  available and preserve the upstream notices. This is a licensing note, not a
  substitute for legal review.

## Bundled server dependencies

The desktop app ships a staged copy of the Fastify server and its runtime npm
dependencies under `resources/server/node_modules`. Direct dependencies of the
staged server (versions are pinned by `apps/desktop/server-package-lock.json`):

| Package | Version | License | Source |
| --- | --- | --- | --- |
| fastify | 5.12.7 | MIT | <https://github.com/fastify/fastify> |
| @fastify/cors | 11.3.1 | MIT | <https://github.com/fastify/fastify-cors> |
| @fastify/rate-limit | 11.2.1 | MIT | <https://github.com/fastify/fastify-rate-limit> |
| @fastify/static | 10.1.6 | MIT | <https://github.com/fastify/fastify-static> |
| @fastify/websocket | 11.3.4 | MIT | <https://github.com/fastify/fastify-websocket> |
| @fastify/multipart | 10.1.6 | MIT | <https://github.com/fastify/fastify-multipart> |
| bonjour-service | 1.4.4 | MIT | <https://github.com/onlxltd/bonjour-service> |
| castv2-client | 1.2.0 | MIT | <https://github.com/thibauts/node-castv2-client> |
| jose | 6.2.12 | MIT | <https://github.com/panva/jose> |
| qrcode | 1.5.4 | MIT | <https://github.com/soldair/node-qrcode> |

Their transitive dependencies are installed from the committed lockfile; each
installed package keeps its own `LICENSE`/`NOTICE` files inside
`resources/server/node_modules`. A current inventory can be produced from
`apps/desktop/server-package-lock.json` (for example with
`license-checker` or `npm-license-crawler`).

## Web application

The Angular web build under `resources/app/browser` includes third-party
packages. Angular's build emits a consolidated license file at
`dist/apps/app/3rdpartylicenses.txt`; see the repository's dependency
manifests for versions and source links.

## Electron/Chromium and system libraries

Electron includes Chromium, V8, Node.js and their third-party components.
Their notices ship with the Electron framework (`LICENSES.chromium.html`,
`LICENSE`, and related files). Linux packages additionally depend on system
libraries provided by the distribution (GTK, NSS, ALSA, etc.) under their own
licenses.
