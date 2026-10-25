# Open Record

A vinyl record-shop listening room for your phone: browse the crates, build playlists, share them with collaborators, and play it all on a virtual turntable.

![Open Record overview](docs/screenshots/00-overview.png)

> **Notices**
>
> - **AI-built:** this app will be created using AI agents. See [AGENTS.md](AGENTS.md) for the rules they follow.
> - **Design:** the design and mockup were created using the Open Design app. The design system is documented in [DESIGN.md](DESIGN.md).
> - **Music disclaimer:** the author is not responsible for any music that users choose to download, and owns no copyrights to any songs downloaded. Users are solely responsible for ensuring they have the rights to any music they download or use.

## Status

v1 (frontend app) is in progress: the Angular + Capacitor app has the five screens, local file import and Settings. It has not been tested on a device yet. The interactive mobile mockup is in `mockup/`.

## Roadmap

Plans for v1 (frontend app), v2 (backend) and later are in [roadmap/](roadmap/README.md).

## Features (as shown in the mockup)

- **Browse:** "The listening room" home with a "Now on the turntable" record (spinning disc and sleeve), Play record / Open player buttons, and genre bins (All, Dance band, Fox trot, Ragtime and more).
- **Search:** search by title, artist, year or genre, with quick suggestions such as Sousa, Ragtime, 1920 and Bach.
- **Library:** saved records (bookmark toggle) and your playlists, each marked Private or Public, with a New playlist button.
- **Playlists:** play or shuffle, add records, rename, delete, and see each record's year and genre.
- **Collaborators:** Private/Public visibility, plus Owner, Editor (can manage records) and Viewer (can listen) roles. A "Viewing as" switch previews what each role can do; members are samples only.
- **Import local files:** add your own audio files (tags and embedded art are read, titles and artists are editable) and play them alongside the bundled records.
- **Settings:** storage usage, clear data, a toggle for online metadata, and credits.
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
mockup/              Interactive HTML mockup (index.html, assets/, ATTRIBUTION.md)
docs/screenshots/    Screenshots of the six screens
roadmap/             Planning docs (v1 frontend, v2 backend, later ideas)
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

## Online metadata credits

Optional online lookups (native app only, never audio) use [MusicBrainz](https://musicbrainz.org) (core data CC0) for track metadata and the [Cover Art Archive](https://coverartarchive.org) for cover art. Cover art remains the copyright of its rights holders. The toggle is in Settings.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Ahnaf. Sample media keep their own licences (see above).
