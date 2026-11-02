# Desktop packaging assets

electron-builder uses this directory as `directories.buildResources`
(`apps/desktop/build`). It contains only icons and documentation; no build
logic is hidden here.

## Icons

| File | Size | Used by |
| --- | --- | --- |
| `icon.png` | 512x512 | Linux targets (and fallback) |
| `icon.ico` | 16, 24, 32, 48, 64, 128, 256 px | Windows NSIS |
| `icon.icns` | 16, 32, 64, 128, 256, 512, 1024 px (+ @2x) | macOS DMG |

All three are generated from `apps/app/resources/icon-only.png` (1024x1024)
and committed, so CI does not need image tooling. Regenerate them with:

```bash
node apps/desktop/build/generate-icons.mjs
```

That script uses `sharp` (already available through the workspace dev
dependencies) and writes the three files in place.

**Fallback:** electron-builder can derive an `.icns`/`.ico` from a square PNG
of at least 512x512. If the committed `.icns`/`.ico` are missing or you cannot
run the generator, delete them and let electron-builder convert `icon.png`
(with the caveat that conversion support depends on the host tooling). Do not
commit a differently sized `icon.png`: keep it at 512x512 or larger.

macOS style note: the source icon is a full-bleed dark square, so the DMG app
icon is square rather than macOS-style rounded. This matches the web/Android
branding and is intentional for v1.0.0.

## Media binaries and the mirror

`dist/apps/desktop/bin` is produced by
[`../scripts/fetch-binaries.mjs`](../scripts/fetch-binaries.mjs). The script
pins yt-dlp and ffmpeg by version and SHA-256 and supports a stable mirror via
`OPEN_RECORD_BINARIES_BASE`. BtbN's dated Linux/Windows ffmpeg tags can
disappear, so CI/release builds should set that variable to a project-hosted
release containing the flat asset layout documented in the script header.

```bash
# Example (the mirror must contain the files listed in the script header)
OPEN_RECORD_BINARIES_BASE=https://github.com/<org>/<repo>/releases/download/desktop-binaries-v1 \
  node apps/desktop/scripts/fetch-binaries.mjs --platform linux --arch x64
```

`dist/apps/desktop/bin/VERSIONS.json` records exactly which assets and hashes
were used. `electron-builder.yml` copies that directory to `resources/bin` and
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) is shipped alongside it.

## Unsigned builds

Installers are unsigned. macOS uses `identity: null` + `hardenedRuntime:
false` and CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false`; Windows has no code
signing certificate. Users will see Gatekeeper/SmartScreen warnings. Do not
add signing secrets to the build without updating this document and the
workflow.
