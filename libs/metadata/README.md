# metadata

Online metadata lookups for Open Record: track info from MusicBrainz and cover art from the Cover Art Archive. Framework-free; HTTP is injected via `MetadataHttp`. Metadata and art only, never audio.

## API

- `MetadataService(http, options?)`
  - `available`: false when the HTTP port is unavailable (web); nothing is requested then.
  - `searchRecordings(query, limit?)`: free-text search, returns `MetadataRecording[]`.
  - `enrich({ title, artist, album?, ... })`: best match above the score threshold plus cover art, or `null`.
  - Never throws; failures give `[]` or `null`.
- `CapacitorMetadataHttp` (native, used by the app) and `FetchMetadataHttp` (tests/dev).
- `RateLimiter`, `METADATA_USER_AGENT`, `METADATA_ATTRIBUTIONS`.

## Rules

- **Rate limit:** every MusicBrainz and Cover Art Archive request goes through one shared queue at 1 request per second. Provide a single app-wide `MetadataService`.
- **User-Agent:** all requests send `OpenRecord/0.1 (https://github.com/open-record)`, as MusicBrainz requires.
- **Native only:** the browser cannot set a User-Agent and may hit CORS, so lookups are skipped on web.
- The app gates lookups behind a Settings toggle and caches results on device.

## Attributions

- [MusicBrainz](https://musicbrainz.org): core data released under CC0.
- [Cover Art Archive](https://coverartarchive.org): a joint project of MusicBrainz and the Internet Archive; images remain copyright of their rights holders.

Run `nx test metadata` to execute the unit tests.
