# Open Record v0.0.5 (beta)

Open Record is a vinyl record-shop listening room: browse the crates, build playlists, import your
own music and play it on a virtual turntable. This is the fifth beta.

## What's new in v0.0.5

- **In-app updates:** Open Record checks GitHub releases for a newer version and shows "Update is Available" or "Restart to Update" on the About item in the sidebar. The About page has Check for updates, auto update and Skip this version controls, and shows the release notes.
- **Windows and Linux AppImage:** the update downloads when you choose it (or automatically if auto update is on) and installs on restart. The `.deb` and macOS builds only notify you.
- **Android:** the app downloads the APK, verifies its SHA-256, then asks Android to install it. You confirm the install. The same signing key is required.
- **Release assets:** each release now also carries `SHA256SUMS` (the APK checksum the app uses), `latest.yml` and `latest-linux.yml` (the desktop update feeds).

## Highlights

- **Browse and play:** a bundled public-domain catalogue, genre bins, a full-screen player with a
  queue, a mini player, and media keys on desktop.
- **Library and playlists:** saved records, Private or Public playlists, sortable library on desktop,
  shuffle and reorder.
- **Imports:** audio files from your device with editable tags and art, Spotify Exportify CSV/JSON,
  and YouTube / YT Music links. Uncertain matches wait in a review list.
- **Stream and save (with your own stream-link server):** search YouTube, YouTube Music and
  SoundCloud, stream a direct link, and save the file to your device. Tags and cover art come from
  iTunes and Deezer.
- **Background downloads:** Wi-Fi by default (mobile data is opt-in), a Library switch and per-playlist
  switches, a foreground service on Android, and a Retry page for failed songs.
- **Optional accounts and sync:** your own Supabase project adds sign-in and syncs metadata, saved
  songs, playlists and import history (never audio).
- **Desktop app:** an Electron app with the UI, local server, `yt-dlp` and `ffmpeg` bundled.
- **Web app:** https://open-record.uttarasoftware.ca. Guests can play the bundled catalogue. Streaming
  from search for guests is rate-limited, and only on servers that enable it. Sign-up is a request the
  owner approves.
- **Accounts on the web:** on a web build with Supabase configured, Library and Playlists require an
  account.

## Downloads

Download links always point at the latest release. File names are the same as before.

| Platform | File | Notes |
|---|---|---|
| Linux x64 (recommended) | [OpenRecord-linux-amd64.deb](https://github.com/ahnafone/open-record/releases/latest/download/OpenRecord-linux-amd64.deb) | `sudo apt install ./OpenRecord-linux-amd64.deb` |
| Linux x64 | [OpenRecord-linux-x86_64.AppImage](https://github.com/ahnafone/open-record/releases/latest/download/OpenRecord-linux-x86_64.AppImage) | `chmod +x`, then run |
| Windows x64 | [OpenRecord-windows-x64.exe](https://github.com/ahnafone/open-record/releases/latest/download/OpenRecord-windows-x64.exe) | SmartScreen warning; More info > Run anyway |
| macOS | [Build from source](docs/desktop.md#build-from-source) | Not in v0.0.5; macOS installers coming later |
| Android | [OpenRecord-android.apk](https://github.com/ahnafone/open-record/releases/latest/download/OpenRecord-android.apk) | Android 7+. Signed release APK; beta-tested |
| iPhone / iPad | [Build from source](docs/ios-install.md) | **Not tested yet.** Needs a Mac, Xcode and a free Apple ID |

There is no App Store, TestFlight, Play Store or enterprise build.

## Known limits

- **Beta.** Expect rough edges. Report problems on the issue tracker.
- **Android:** beta-tested on devices. The app installs its own updates after you confirm. Updates install over the old app only when signed with the same key; uninstalling deletes downloads.
- **iPhone:** not tested on a device yet. It is build-from-source only, and a free Apple ID build
  expires after **7 days** and must be re-signed from Xcode.
- **Desktop:** installers are **unsigned**, so Windows (SmartScreen) shows warnings. Windows and AppImage builds update in the app. `.deb` and macOS builds need a manual reinstall over the old version. Your library is kept in the app's data folder.
- **macOS installers are not part of v0.0.5.** Build from source; see [docs/desktop.md](docs/desktop.md#build-from-source).
- **Streaming and saving** depend on a stream-link server and `yt-dlp`. Links expire. With your own
  server, streaming works on the same network as the server, not on mobile data. Guest streaming on the
  public web app is rate-limited and only on servers that enable it.
- **Phones on the same Wi-Fi** talk to the desktop or self-hosted server over plain HTTP. Use a trusted
  network only.
- **Collaborators** is hidden in this release.

## Checksums

Every file on the release page is listed in `SHA256SUMS.txt`. To check a
download, put it in the same folder as the file and run:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

On Windows, use `certutil -hashfile <file> SHA256` and compare the result with the matching line.

## Install guides

- Desktop: [docs/desktop.md](docs/desktop.md)
- iPhone (build from source, untested): [docs/ios-install.md](docs/ios-install.md)
- Self-hosting the server: [apps/server/README.md](apps/server/README.md)

## Music disclaimer

The author owns no copyrights to any music users download and is not responsible for what they choose
to download. You are solely responsible for having the rights to any music you download, stream or use.
