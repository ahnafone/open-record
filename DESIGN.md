---
version: alpha
name: Open Record
description: A dark, warm vinyl listening room for browsing a record shop's crates, playing records and building shared playlists on a phone.
colors:
  primary: "#ff8d83"
  primary-hover: "#ffa098"
  on-primary: "#2a1210"
  background: "#171b20"
  surface: "#252c33"
  surface-raised: "#2f383f"
  text: "#f5f0e6"
  muted: "#bcc4cb"
  border: "#56616c"
  ivory: "#efe5cf"
  ink: "#16181c"
  vinyl: "#0b0d10"
typography:
  display:
    fontFamily: Georgia
    fontSize: 32px
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: 0em
  headline:
    fontFamily: Georgia
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: 0em
  title:
    fontFamily: Georgia
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: 0em
  section:
    fontFamily: Georgia
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: 0em
  body:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0em
  button:
    fontFamily: system-ui
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0em
  row-title:
    fontFamily: system-ui
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0em
  body-sm:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0em
  meta:
    fontFamily: system-ui
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0.02em
  eyebrow:
    fontFamily: system-ui
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0.16em
  tab-label:
    fontFamily: system-ui
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: 0.04em
rounded:
  none: 0px
  sleeve: 3px
  md: 8px
  full: 999px
spacing:
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  gutter: 16px
  touch: 44px
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 14px
    height: 44px
  button-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 14px
    height: 44px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    height: 44px
  icon-button:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    size: 44px
  icon-button-active:
    textColor: "{colors.primary}"
  chip:
    backgroundColor: "{colors.background}"
    textColor: "{colors.muted}"
    rounded: "{rounded.full}"
    padding: 14px
    height: 44px
  chip-selected:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.ink}"
  tag:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.full}"
    padding: 9px
    height: 23px
  tag-ivory:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 44px
  search-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 48px
  topbar:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    typography: "{typography.title}"
    padding: 8px
    height: 56px
  tabbar:
    backgroundColor: "{colors.background}"
    textColor: "{colors.muted}"
    typography: "{typography.tab-label}"
    padding: 8px
  tab:
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    height: 48px
  tab-current:
    textColor: "{colors.text}"
  record-row:
    textColor: "{colors.text}"
    typography: "{typography.row-title}"
    rounded: "{rounded.md}"
    padding: 4px
    height: 72px
  track-row:
    textColor: "{colors.text}"
    typography: "{typography.row-title}"
    rounded: "{rounded.md}"
    padding: 4px
    height: 60px
  track-row-current:
    textColor: "{colors.primary}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 12px
  playlist-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.section}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 64px
  playlist-row-hover:
    backgroundColor: "{colors.surface-raised}"
  member-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 10px
  sleeve:
    backgroundColor: "{colors.ivory}"
    rounded: "{rounded.sleeve}"
    padding: 6px
  disc:
    backgroundColor: "{colors.vinyl}"
    rounded: "{rounded.full}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  disc-label:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
  transport-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.full}"
    size: 52px
  transport-button-main:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
    size: 68px
  miniplayer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    padding: 6px
  modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
    width: 336px
  toast:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 14px
---

# Open Record

## Overview

Open Record is a mobile listening room for a vintage vinyl record shop. Users
browse the shop's crates, search, keep a personal library, play records in a
now-playing view, and build playlists with collaborators. The visual language
borrows from a dim, after-hours record shop: a charcoal room, cream paper
sleeves, black grooved discs, serif liner-note headings and a single warm coral
light used for whatever is "on the turntable".

The design was produced in the Open Design app as a high-fidelity interactive
mockup (`mockup/index.html`) presented inside a 393 x 852 px phone frame
(59px top safe area, 34px bottom). It covers six screens: Browse (the
"listening booth" hero plus horizontal crate bins), Search, Library, Playlist,
Collaborators, and Now Playing, with a persistent mini player and a three-tab
bar (Browse, Search, Library).

Personality: tactile, unhurried, editorial. It should feel like flipping
through a well-kept crate, not like a streaming dashboard. Records are always
shown as physical objects (an ivory-bordered sleeve with a disc peeking out),
never as bare square thumbnails.

## Colors

The palette is dark-only (`color-scheme: dark`) and deliberately small.

- **Primary (`#ff8d83`, coral):** the "needle-down" colour. Used for the main
  call to action, the play/pause transport button, the current track title,
  pressed toggles, the active tab icon, progress fills, focus rings and error
  text. Hover lightens to `#ffa098`. Text on coral is the deep brown
  `#2a1210`, never white.
- **Background (`#171b20`):** the room. App canvas, top bar, tab bar and input
  fields.
- **Surface (`#252c33`) / Surface raised (`#2f383f`):** cards, panels,
  playlist rows, the mini player, modals. Raised is the hover state.
- **Text (`#f5f0e6`):** warm off-white primary text, not pure white.
- **Muted (`#bcc4cb`):** artists, metadata, eyebrows, inactive tabs.
- **Border (`#56616c`):** hairlines and outlines, usually applied at reduced
  opacity (0.3 to 0.75) so rules recede.
- **Ivory (`#efe5cf`) / Ink (`#16181c`):** paper. Record sleeve borders, disc
  centre labels, the selected chip, ivory tags and the toast.
- **Vinyl (`#0b0d10`):** groove and spindle colour for discs, drawn with a
  repeating radial gradient against `#1c2229`.
- The presentation backdrop behind the phone frame is `#0f1216`; it is not
  an app token and never appears inside the app.

Tinted states are built from the coral at low alpha: banners use a 10% coral
fill with a 42% coral border; danger buttons use 8% fill (16% on hover) with a
55% border.

Measured WCAG 2.x contrast ratios:

| Pair | Ratio | Use |
| --- | --- | --- |
| text on background | 15.2:1 | body copy |
| text on surface-raised | 10.5:1 | hovered rows |
| muted on background | 9.8:1 | metadata |
| muted on surface | 8.0:1 | metadata in cards |
| primary on background | 7.7:1 | current track, errors |
| primary on surface | 6.3:1 | danger button text |
| on-primary on primary | 7.9:1 | primary buttons |
| ink on ivory | 14.2:1 | chips, tags, toast |
| border on background | 2.7:1 | decorative hairlines only |

## Typography

Two families, set as CSS variables:

- **Display:** `Georgia, "Times New Roman", serif`. Used for the brand
  wordmark (20px), screen titles (display 32px / 1.15, h1 24px / 1.2, h2
  20px / 1.25), bin section heads (18px, 600), playlist names (18px) and modal
  titles (20px, 600). It plays the role of liner-note or shop-sign lettering.
- **Body:** `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial,
  sans-serif`. Base 16px / 1.5 with antialiasing. Buttons 15px (600 on
  primary), record titles 15px/600, track titles 14px/600, artists 13px,
  details and timestamps 12px, tags and tab labels 11px.
- **Eyebrows and labels:** 11px uppercase with 0.12em to 0.16em tracking in
  muted colour (field labels, kickers, the brand tagline at 10.5px / 0.15em).
- Times use `font-variant-numeric: tabular-nums` so the seek bar does not
  jitter.

## Layout

- **Frame:** designed for a 393 x 852 px phone screen. Below 480px viewport
  width the handset chrome is removed and the app fills the viewport,
  respecting `env(safe-area-inset-*)`.
- **App skeleton:** a three-row grid: top bar (min 56px), a scrolling screen
  host, and a dock containing the mini player and tab bar. Chrome never
  scrolls; each screen scrolls internally with hidden scrollbars.
- **Gutters:** screens use 12px top, 16px sides, 24px bottom padding.
  Horizontal crate rails bleed to the screen edge (`margin: 0 -16px`) and
  re-pad 16px so the next sleeve peeks in.
- **Spacing scale:** 2, 4, 8, 12, 16, 24px. Lists use 8px gaps; panels pad
  12px; modals pad 16px with 12px internal gaps.
- **Rows:** record rows are at least 72px tall, track rows 60px, playlist rows
  64px. Rows are separated by 1px hairlines (border at ~32% opacity) rather
  than boxed, except playlist and member rows which are surface cards.
- **Touch targets:** every interactive element is at least 44 x 44px
  (buttons, chips, tabs at 48px, icon buttons, sliders 44px tall).
- **Section heads:** serif title followed by a flexible 1px rule that runs to
  the edge, like a divider card in a record bin.

## Elevation & Depth

The interface is mostly flat; depth is reserved for physical objects and
overlays.

- **Flat UI:** cards and rows differentiate by surface colour plus a
  semi-transparent border, not by shadow.
- **Physical records:** sleeves cast real shadows (`0 16px 30px rgba(0,0,0,.55)`
  on the booth, `0 18px 34px` on Now Playing, `0 4px 10px rgba(0,0,0,.4)` on
  thumbnails). The disc sits behind the sleeve (z-index 1 vs 2) and has
  `0 10px 24px rgba(0,0,0,.5)` plus a faint inner rim.
- **Overlays:** modals sit on a `rgba(9,11,14,.68)` backdrop with
  `0 24px 50px rgba(0,0,0,.55)`. The toast is an ivory slip near the bottom
  safe area.
- **Motion:** easing `cubic-bezier(.23,1,.32,1)` for everything. Hover and
  exit transitions are 140ms; screen enter and toast enter are 200ms. Screens
  fade in while rising 8px. Presses scale to 0.97 (buttons) or 0.94 (icon and
  transport buttons). A playing disc rotates once every 8s, linearly.
- **Reduced motion:** under `prefers-reduced-motion: reduce`, transitions drop
  to ~1ms, screens stop translating and spinning discs stop.

## Shapes

- **8px (`rounded.md`)** is the single UI radius: buttons, inputs, search
  field, cards, rows, tabs, modals, banners, toast.
- **Pills (`rounded.full`)** for chips and tags only.
- **Circles** for discs, disc labels, the brand mark, transport buttons and
  the seek thumb (16px).
- **3px (`rounded.sleeve`)** for record sleeves (2px on small thumbnails):
  cardboard corners stay nearly square.
- Icons are stroked line icons, 1.8px stroke, round caps and joins, inheriting
  `currentColor`.

## Components

- **Buttons:** default is a surface button with a 75%-opacity border; primary
  is solid coral with brown text; danger is coral text on a faint coral tint.
  Small variant is 14px text with 12px side padding. Disabled at 42% opacity.
- **Icon buttons:** 44px transparent squares; hover adds 7% white; pressed
  toggles (`aria-pressed`) turn coral.
- **Chips:** outlined pills in muted text for filters; the selected chip
  becomes ivory with ink text, like a paper price sticker.
- **Tags:** 23px pills for genre and format, muted on 6% white; the ivory
  variant flags a special attribute.
- **Inputs and search:** inputs use the background colour with a full-opacity
  border; focus and `aria-invalid` switch the border to coral. Errors appear
  below in 12px coral text with reserved height so the layout does not jump.
- **Top bar:** brand mark (a 30px disc with a coral spindle), serif wordmark
  and uppercase tagline.
- **Listening booth (Browse hero):** a surface card with an ivory sleeve
  overlapping a grooved disc that spins while playing, followed by serif
  title and muted subtitle.
- **Record and track rows:** sleeve thumbnail (60px sleeve plus peeking disc),
  title, artist, detail and tags; the current item's title turns coral.
- **Missing artwork:** a designed fallback, a grooved disc with an ivory centre
  label; never a broken-image icon or a fake sleeve.
- **Now Playing:** large sleeve over a disc, artist in muted 15px, a status
  line (loading spinner or coral error), a seek slider (4px track, coral
  fill, 16px coral thumb ringed in background colour) with tabular times, and
  a transport row of 52px circular buttons around a 68px coral play button.
- **Mini player:** surface strip above the tab bar with a 2px coral progress
  line on its top edge, a 44px ivory-framed thumbnail, title and artist.
- **Tab bar:** three equal tabs, 48px tall; the current tab has text-colour
  label and coral icon.
- **Playlists and collaborators:** surface cards with serif names and muted
  meta; member rows include a role select. An informational banner uses the
  coral tint. Empty states use a dashed border and centred muted copy.
- **Modal:** max 336px wide, max 82% tall, serif title, stacked actions.
- **Toast:** ivory slip with ink text, slides up 10px and fades in.

## Do's and Don'ts

**Do**

- Use coral (`primary`) for one job: what is active, playing, focused or
  wrong. Keep it to a single prominent coral element per view.
- Put dark brown `#2a1210` text on coral surfaces (7.9:1).
- Show records as objects: ivory-bordered sleeve, disc behind, real shadow.
- Use Georgia for titles and names, system-ui for everything functional.
- Keep body and meta text at or above WCAG AA 4.5:1 (all palette text pairs
  already exceed 6:1) and non-text indicators at or above 3:1.
- Keep every touch target at least 44 x 44px and show the 2px coral
  `:focus-visible` outline with 2px offset.
- Respect `prefers-reduced-motion`: stop disc rotation and screen slides.
- Reserve space for status and error lines so content never jumps.

**Don't**

- Don't use pure white text or a pure black canvas; stay with `#f5f0e6` and
  `#171b20`.
- Don't put white text on coral (about 2.6:1) or coral text on ivory.
- Don't rely on the border colour alone to signal state: `#56616c` is only
  2.7:1 on the background, so pair it with colour, weight or an icon.
- Don't add new accent hues, gradients on UI controls, or shadows on flat
  cards and rows.
- Don't use radii other than 8px, pill, circle or 3px sleeve corners.
- Don't crop or stretch cover art; fit it inside the sleeve
  (`object-fit: contain`) and use the disc fallback when it is missing.
- Don't animate longer than 200ms for UI transitions or use bouncy easing.
- Don't convey "now playing" by colour alone; pair it with the spinning disc,
  progress bar or pressed state.
