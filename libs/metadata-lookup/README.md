# metadata-lookup

Pure iTunes + Deezer track metadata lookup. No Node-only APIs: the caller
injects `fetch` (for example a CapacitorHttp-backed function on native).

## Public API

- `lookupMetadata({ title, artist?, durationSec? }, fetchFn)` -> `{ match }`
- `normalizeTitle`, `normalizeArtist`, `pickBest`, `MATCH_THRESHOLD`
- Types: `MetadataMatch`, `MetadataQuery`, `MetadataSource`, `MetadataFetch`

## Running unit tests

Run `nx test metadata-lookup` to execute the unit tests via [Vitest](https://vitest.dev/).
