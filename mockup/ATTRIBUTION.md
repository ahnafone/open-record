# Attribution — OpenRecord sample catalogue

OpenRecord is a **design mockup**, not a music service. Every audio file and
every piece of cover art shipped in `assets/` is an openly licensed historical
item downloaded from Wikimedia Commons. No commercial title is attached to
audio that does not belong to it: each record is the real recording, credited
to its real performers, with the item's own historical artwork where one
exists.

- Audio: 5 files under `assets/audio/` (MP3, 96 kbps CBR, 44.1 kHz stereo)
- Artwork: 5 files under `assets/art/` (original JPEGs, unmodified)
- App metadata (title, artist, composer, year, genre, format, label, licence)
  is taken from the source pages listed below.

Four of the five recordings are in the public domain or dedicated to the public
domain (CC0). The fifth — the *Harlem Rag* piano performance — is **not** public
domain: it is a 2026 self-published performance released by its uploader under
**[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)**, while the *composition* it performs (Tom Turpin, 1897) is
public domain. All five artwork files are public domain. There is therefore no
blanket "everything here is public domain" claim in this document or in the app.

Every licence statement below was read from the Wikimedia Commons API
(`imageinfo.extmetadata`) **and** the file page's raw wikitext — the extmetadata
"Licence short name" alone is not sufficient, because a page can carry two
licence templates (composition vs performance). The captured evidence is saved
at `/tmp/opencode/openrecord-license-evidence.txt`.

---

## Audio

Each file was transcoded once from the original Wikimedia Ogg Vorbis source to
MP3 with `ffmpeg 6.1.1` (LAME, 44.1 kHz, stereo, 96 kbps, EBU R128 loudness
normalisation to `I=-16 TP=-1.5 LRA=11`). No other edit was applied. MP3 was
chosen so the recording plays in desktop and mobile Safari, which does not
play Ogg Vorbis.

**Licence of the transcoded files.** For a public-domain or CC0 source the
transcode imposes no new conditions (a faithful format conversion of a
no-rights-reserved work). For `harlem-rag.mp3` the transcode is a **derivative
of a CC BY-SA 3.0 work and is therefore itself distributed under CC BY-SA 3.0**:
attribution to the performer/uploader is required, and any redistribution of
that file must carry the same licence. The other four MP3s remain public
domain / CC0.

| # | App file | Duration | Size | Source file (Wikimedia Commons) | Licence |
|---|----------|----------|------|--------------------------------|---------|
| 1 | `assets/audio/japanese-sandman.mp3` | 3:00 | 2.11 MB | [`"The Japanese Sandman" (1920), by Paul Whiteman and His Ambassador Orchestra.oga`](https://commons.wikimedia.org/wiki/File:%22The_Japanese_Sandman%22_(1920),_by_Paul_Whiteman_and_His_Ambassador_Orchestra.oga) | Public domain |
| 2 | `assets/audio/afghanistan.mp3` | 3:16 | 2.35 MB | [`"Afghanistan" - Fox Trot- Prince's Dance Orchestra- Columbia 1920.ogg`](https://commons.wikimedia.org/wiki/File:%22Afghanistan%22_-_Fox_Trot-_Prince%27s_Dance_Orchestra-_Columbia_1920.ogg) | Public domain |
| 3 | `assets/audio/harlem-rag.mp3` | 2:52 | 2.07 MB | [`Tom Turpin - Harlem Rag Two Step (1897).ogg`](https://commons.wikimedia.org/wiki/File:Tom_Turpin_-_Harlem_Rag_Two_Step_(1897).ogg) | **Composition public domain; performance CC BY-SA 3.0** — see below |
| 4 | `assets/audio/sousa-columbias-pride.mp3` | 1:08 | 0.82 MB | [`"Columbia's Pride" (1914) by John Philip Sousa, performed by the U.S. Marine Band directed by Col. Jason K. Fettig.ogg`](https://commons.wikimedia.org/wiki/File:%22Columbia%27s_Pride%22_(1914)_by_John_Philip_Sousa,_performed_by_the_U.S._Marine_Band_directed_by_Col._Jason_K._Fettig.ogg) | Public domain (U.S. Government work) |
| 5 | `assets/audio/bach-goldberg-aria.mp3` | 4:47 | 3.45 MB | [`Bach, Goldberg Variations, Aria (Musopen version).ogg`](https://commons.wikimedia.org/wiki/File:Bach,_Goldberg_Variations,_Aria_(Musopen_version).ogg) | CC0 1.0 |

Recording credits shown in the app:

- **The Japanese Sandman** — performed by *Paul Whiteman and His Ambassador
  Orchestra* (1920). Composition by Richard A. Whiting and Raymond B. Egan.
  The source file's own description credits the 1920 performance.
- **Afghanistan (Fox Trot)** — performed by *Prince's Dance Orchestra*,
  Columbia, recorded 1920-01-28; bandleader Charles A. Prince.
- **Harlem Rag (Two Step)** — *work*: composed by **Tom Turpin** in **1897**
  (public domain). *Recording*: a **2026 performance by Wikimedia Commons
  contributor Gnissah**, self-published on 2026-03-05 and licensed
  **CC BY-SA 3.0** — see the dedicated section below. The app shows the
  composition year (1897) as the record's year and names the composer as the
  artist, with the recording credit ("recording by Gnissah, 2026") alongside.
- **Columbia's Pride (March)** — composed by *John Philip Sousa* (1914);
  performed by the **U.S. Marine Band**, directed by Colonel Jason K. Fettig.
  A U.S. Government recording, hence public domain.
- **Goldberg Variations, BWV 988 — Aria** — composed by *J. S. Bach*; the
  recording is the **Musopen** recording, dedicated to the public domain under
  **CC0 1.0**. (Commons notes this is *not* the same performance as the Open
  Goldberg Variations set.)

### Harlem Rag (Two Step) — composition vs performance

This is the one item in the catalogue that is **not** public domain, and the
distinction matters:

| Element | Fact | Licence |
|---------|------|---------|
| Composition | *Harlem Rag*, Tom Turpin, 1897 (revised/arr. W. H. Tyers) | Public domain (`{{PD/1923}}`) |
| Performance / recording | piano performance by Commons user **Gnissah**, uploaded 2026-03-05, source "own work" | **CC BY-SA 3.0** — [licence deed](https://creativecommons.org/licenses/by-sa/3.0/) (`{{self\|Cc-by-sa-3.0}}`) |
| File shipped here | `assets/audio/harlem-rag.mp3`, an MP3 transcode of that performance | **CC BY-SA 3.0** (derivative; share-alike + attribution) |

Evidence: the raw wikitext of
[`File:Tom Turpin - Harlem Rag Two Step (1897).ogg`](https://commons.wikimedia.org/wiki/File:Tom_Turpin_-_Harlem_Rag_Two_Step_(1897).ogg)
carries two templates — `;Composition {{PD/1923}}` and `;Performance
{{self|Cc-by-sa-3.0}}` — and the page is categorised under `CC-BY-SA-3.0` and
`Self-published work`. The API's `extmetadata.LicenseShortName` reports
"Public domain" because it reflects the composition template, which is exactly
why the raw wikitext was checked. Full captured evidence:
`/tmp/opencode/openrecord-license-evidence.txt`.

Required credit for this recording: **"Harlem Rag (Two Step)" — performed by
Gnissah (Wikimedia Commons), 2026, licensed
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).** If this file
is reused outside local design review, keep that credit, the licence name and
deed link, and the share-alike terms (or substitute a public-domain recording).

## Artwork

Dimensions below are the **actual intrinsic pixel size**, measured with
`ffprobe` (`-select_streams v:0 -show_entries stream=width,height`) on the file
as shipped, before any styling. The JPEGs are the originals, unmodified; the
app displays them with `object-fit: contain` / natural aspect ratio, so no
album art is cropped and no derivative file is created.

| Record | App file | Intrinsic size | Source (Wikimedia Commons) | Licence / credit |
|--------|----------|----------------|---------------------------|------------------|
| The Japanese Sandman | `assets/art/sandman.jpg` | 415 × 570 | [`"The Japanese Sandman" (1920), by Richard A. Whiting and Raymond B. Egan.jpg`](https://commons.wikimedia.org/wiki/File:%22The_Japanese_Sandman%22_(1920),_by_Richard_A._Whiting_and_Raymond_B._Egan.jpg) | Public domain. Sheet-music cover, 1920; artwork by Frederick S. Manning |
| Afghanistan (Fox Trot) | `assets/art/prince.jpg` | 490 × 507 | [`Charles A. Prince.jpg`](https://commons.wikimedia.org/wiki/File:Charles_A._Prince.jpg) | Public domain. Columbia Phonograph Company, 1908 catalogue |
| Harlem Rag (Two Step) | `assets/art/harlem-rag.jpg` | 500 × 597 | [`HarlemRag.jpg`](https://commons.wikimedia.org/wiki/File:HarlemRag.jpg) | Public domain. 1899 sheet-music cover, Jos. W. Stern & Co., New York |
| Columbia's Pride (March) | `assets/art/sousa.jpg` | 2607 × 3762 | [`JohnPhilipSousa-Chickering.LOC.jpg`](https://commons.wikimedia.org/wiki/File:JohnPhilipSousa-Chickering.LOC.jpg) | Public domain. Photograph by Elmer Chickering, c. 1900; Library of Congress |
| Goldberg Variations — Aria | `assets/art/bach.jpg` | 1376 × 1786 | [`Johann Sebastian Bach.jpg`](https://commons.wikimedia.org/wiki/File:Johann_Sebastian_Bach.jpg) | Public domain. Portrait by Elias Gottlob Haussmann, 1748 |

Artwork notes:

- `harlem-rag.jpg` was fetched as a 500 px-wide Wikimedia thumbnail (a
  standard thumbnail step), which is why its intrinsic size is 500 × 597 and
  not the original 720 × 860. It is used as a sleeve image and is not
  cropped in the app.
- The sleeve for each record is genuinely associated with it: the 1899 *Harlem
  Rag* sheet music of the work's composer (Tom Turpin), the 1920 *Japanese
  Sandman* sheet music, the performers' own period portraits where no sleeve
  exists, and the Sousa portrait for the Marine Band march.
- No real cover art from a commercial release is used anywhere in this mockup.

## Presentation shell and layout primitives

- The iPhone handset shell in `index.html` (the first `<style>` block:
  `.phone-frame`, `.phone-screen`, `.phone-content`, `.dynamic-island`,
  `.status-bar`, `.home-indicator`, `.hardware-button`, and the `<480px`
  viewport fallback) is the Open Design OD Next device frame at
  `plugins/_official/scenarios/od-next-strategy/assets/task-profiles/prototype/device-frames/iphone.html`,
  derived from the Open Design mobile-app template (Apache-2.0). Only the stage
  colours (`--phone-system-fg`, `--phone-screen-bg`, `--phone-stage-bg`, body
  background) and the app content inside `.phone-content` were changed; the
  hardware keys, status bar, Dynamic Island, home indicator and the `<480px`
  full-screen fallback are preserved.
- The `@layer od-layout { … }` block at the top of `index.html` is a verbatim
  copy of OD-LAYOUT-PRIMITIVES v1 from
  `plugins/_official/scenarios/od-next-strategy/assets/task-profiles/prototype/layout.css`,
  including its source header comment and its closing
  `/* /OD-LAYOUT-PRIMITIVES v1 */` marker (structure only — it sets no palette,
  type, or spacing of its own).

## Reproducing the pipeline

```bash
# audio: Ogg Vorbis source -> MP3 (Safari-compatible)
ffmpeg -i <source>.ogg -af loudnorm=I=-16:TP=-1.5:LRA=11 \
  -ar 44100 -ac 2 -c:a libmp3lame -b:a 96k assets/audio/<name>.mp3

# imagery: measure the intrinsic size with ffprobe, then style in CSS
ffprobe -v error -select_streams v:0 -show_entries stream=width,height \
  -of csv=p=0 assets/art/<name>.jpg
```
