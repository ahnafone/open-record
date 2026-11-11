# Open Record desktop app

Open Record for desktop bundles the web UI, the local Fastify server, yt-dlp and ffmpeg in
one Electron app. It works offline for the bundled catalogue, local imports and playback;
an optional Supabase project adds sync and lets phones on your Wi-Fi use the same library.
The window loads a fixed local address, `http://127.0.0.1:47900`, not a public server (see
[Public access](../README.md#public-access)).

> **Unsigned builds.** SmartScreen will warn you on Windows. Windows and AppImage
> builds update in the app; `.deb` and macOS builds only notify you, so reinstall over the old one.
> Windows installers are CI-built and untested here. macOS installers are
> not published in v0.0.5; [build from source](#build-from-source) instead.

## Download and install

Get your file from the
[latest release](https://github.com/ahnafone/open-record/releases/latest).

| System                  | File                               | Install                                         |
| ----------------------- | ---------------------------------- | ----------------------------------------------- |
| Linux x64 (recommended) | `OpenRecord-linux-amd64.deb`       | `sudo apt install ./OpenRecord-linux-amd64.deb` |
| Linux x64               | `OpenRecord-linux-x86_64.AppImage` | `chmod +x`, then run it                         |
| Windows x64             | `OpenRecord-windows-x64.exe`       | Run, then launch from the Start menu            |
| macOS (Apple Silicon and Intel) | Not published in v0.0.5 | [Build from source](#build-from-source) |

### Linux

The deb is the primary install on Ubuntu 24.04: it adds the launcher entry and avoids the
AppImage's FUSE and sandbox problems.

```bash
sudo apt install ./OpenRecord-linux-amd64.deb
open-record
```

The AppImage needs FUSE 2; if it reports `libfuse.so.2`, install `libfuse2t64` (`libfuse2`
on 22.04). If AppArmor's user-namespace restriction blocks Chromium's sandbox, prefer the
deb; as a last resort the AppImage accepts `--no-sandbox`, which disables Chromium's
process sandbox.

### Windows

Run `OpenRecord-windows-x64.exe`. SmartScreen reports "Windows protected your PC" and an
Unknown publisher: choose **More info > Run anyway**. Defender may scan the bundled
binaries on first launch.

### macOS

Not published in v0.0.5, and there is no macOS DMG on the release page. Build the app from
source instead: see [Build from source](#build-from-source).

<!-- Restore this section when macOS DMGs are published again.
Open the DMG, drag **Open Record** to Applications, then right-click the app and choose
**Open** (or **System Settings > Privacy & Security > Open Anyway**) the first time. If
macOS still says the app is damaged, clear quarantine:

```bash
xattr -dr com.apple.quarantine "/Applications/Open Record.app"
```
-->

## Build from source

Use this on macOS for now, or to build any platform yourself. You need Node 24 and npm.

```bash
npm ci
npm run desktop:dist
```

`desktop:dist` builds the web UI and server, fetches the bundled yt-dlp and ffmpeg, and writes
the installer for the current OS to `dist/apps/desktop/release/`. On macOS, set
`CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder skips signing-identity lookup, as CI
does. Local builds are unsigned and are not tested by the project on macOS for v0.0.5.

## First run

The app starts its server and opens a window at `http://127.0.0.1:47900/`; no wizard and
no account is required. The address is fixed because browser storage is tied to the
origin, and if 47900 is taken the app reports an error rather than choosing another.

| Works offline                                                     | Needs internet                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Browsing the bundled catalogue and your library                   | Searching download sources (YouTube, YouTube Music, SoundCloud), pasting links |
| Importing audio (Import > "Audio files on this device"), playback | Streaming or saving remote tracks, tag/cover-art lookups                       |
| Playlists, import history, play counts, settings                  | Signing in and syncing with Supabase                                           |

Without an account the app is anonymous and every local feature works; an account is
needed for sync, Cast and phones. If Supabase is configured but the network is down,
sign-in fails safely and local features keep working. The local token is generated once,
never shown, and never sent to phones.

### Data folder and logs

Everything lives in Electron's user-data folder; **Settings > Desktop app > Open data
folder** opens it.

| System  | Folder                                      |
| ------- | ------------------------------------------- |
| Linux   | `~/.config/Open Record`                     |
| macOS   | `~/Library/Application Support/Open Record` |
| Windows | `%APPDATA%\Open Record`                     |

- `config.json` - Supabase URL, anon key and the optional legacy JWT secret, plus the LAN toggle
  (0600; secrets are not shown again after saving). `server/` holds the server state and `token`;
  `logs/server.log` holds output and startup errors. The rest is Chromium storage (IndexedDB,
  localStorage, cached files): library, imported audio, downloads and settings.

## Desktop setup page

Open **Settings** and choose **Desktop app** (or go to `http://127.0.0.1:47900/desktop`).

- **Project URL** and **Anon (public) key** - connect your own project. The anon key is
  public; never paste a `service_role` or `sb_secret_...` key. The page refuses those.
- **Advanced: legacy JWT secret** - optional, for older HS256 projects only; new projects
  need none. Never a service-role key here.
- **Save & test** - saves the config and restarts the local server; the status reports the
  configured host, never the key. If the new settings stop the server, the previous config
  is restored. **Restart server** reapplies a saved config or recovers a wedged server;
  either drops the in-memory playback/cast session, while the library stays safe.
- **Phones on this network** - its **Allow phones on this network** switch restarts the
  server on all interfaces and shows the LAN address, a copy button and a QR code. Trusted
  networks only; turning it off returns to loopback.

## Connect your own Supabase project

Accounts, sync, Cast and phone sign-in use a Supabase project you create and own; Open
Record hosts nothing. At [supabase.com](https://supabase.com), create **New project**,
pick a region, set a database password and wait for provisioning.

1. **Apply the migrations, in filename order.** Paste each file from
   [`supabase/migrations/`](../supabase/migrations/) into the dashboard **SQL Editor**, or
   use the CLI from the repository root:

   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```

   The ref is in the dashboard URL; `link` asks for the database password. `db push`
   applies the migrations in filename order. Do not reorder or skip them.

2. **Enable Email auth.** Under **Authentication > Sign In / Providers**, keep **Email**
   enabled and set **Minimum password length** to **6** (what the app and
   `supabase/config.toml` use). Email confirmation is on by default.

3. **Set the URLs.** Under **Authentication > URL Configuration**:
   - **Site URL**: `http://127.0.0.1:47900`
   - **Redirect URLs**: `http://127.0.0.1:47900/**` and `http://<lan-ip>:47900/**` (for
     example `http://192.168.1.20:47900/**`)

   Hosts match exactly (`localhost` vs `127.0.0.1`, `http` vs `https`); use the address
   the desktop shows with phones on.

4. **Create the owner account** before closing sign-ups: in the app, **Settings >
   Account > Create account** and confirm the email, or **Authentication > Users > Add
   user** with **Auto Confirm User** checked.

5. **Close sign-ups.** Under **Authentication > Sign In / Providers**, turn off **Allow
   new users to sign up** and **Anonymous sign-ins**. Existing accounts still sign in and
   reset passwords; re-enable sign-ups briefly to add someone later.

6. **Verify row-level security.** In the SQL Editor:

   ```sql
   select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1;
   select tablename, policyname, roles from pg_policies where schemaname = 'public' order by 1, 2;
   ```

   Every table should have `rowsecurity = true`, and no policy should include the `anon`
   role. The migrations revoke `anon` access; signed-in users see only their own rows.

7. **Connect the app.** In **Settings > Desktop app**, paste the **Project URL**
   (`https://<project-ref>.supabase.co`, from **Project Settings > API**) and the **Anon
   (public) key**. **Save & test**, then **Restart server** if asked. Sign in under
   **Settings > Account**.

Legacy HS256 projects only: if sign-in works but the local server returns 401, paste the
project's JWT secret under **Advanced** and save (at least 32 characters). Never use the
service-role key.

## Phones on the same Wi-Fi

Phones reach the desktop's server over the LAN in plain HTTP, for your own trusted network
only.

1. Put the phone and computer on the same Wi-Fi. Guest networks and separate VLANs usually
   cannot reach each other.
2. In **Settings > Desktop app**, turn on **Allow phones on this network**. The server
   restarts and shows the LAN address, a copy button and a QR code.
3. Scan the QR with the phone camera (or type the URL into the phone browser), then sign
   in with the same Supabase account. In the phone app, enter the same URL under
   **Settings > Stream server** and sign in there too. The local token is never shared.
4. Allow TCP 47900 from the LAN only:

   ```bash
   sudo ufw allow from 192.168.1.0/24 to any port 47900 proto tcp
   ```

   On Windows, allow Open Record on the Private network; on macOS, allow incoming
   connections for Open Record in **System Settings > Network > Firewall**.

- **HTTP, not HTTPS.** Your Supabase session and other LAN traffic are unencrypted. Use a
  network you trust, and turn the toggle off when done. Keep the computer awake, and
  reserve a DHCP address if its IP changes. On macOS 15+, allow the Local Network prompt.
- **Never port-forward 47900** or expose it to the internet; for outside access,
  put your own server behind HTTPS, as described in [Public access](../README.md#public-access).
- **Same subnet, no client isolation.** "AP isolation" and guest networks block
  phone-to-computer traffic; browsers on `https://` pages cannot use an `http://` server.

## Troubleshooting

**Port 47900 is already in use.** The app says "Port 47900 on 127.0.0.1 is already in
use." Close the other process and relaunch; a second launch focuses the existing window.

```bash
lsof -nP -iTCP:47900 -sTCP:LISTEN                    # Linux/macOS
Get-NetTCPConnection -LocalPort 47900 -State Listen  # Windows PowerShell
```

**The server fails to start.** The dialog names it ("The local server failed to start" or
"The local server stopped"). Open `logs/server.log`. Usual causes: antivirus quarantining
the bundled yt-dlp/ffmpeg, an unwritable data folder, a corrupt install. Quit, relaunch,
reinstall the same version if needed.

**`/app-config` returns nulls.** The server is not running with your Supabase settings.
Check `http://127.0.0.1:47900/app-config`; save again with **Save & test**, make sure the
Project URL is exactly `https://<project-ref>.supabase.co` with no path or spaces, and use
**Restart server**.

**401 errors.** A 401 from the local server usually means the request had no valid token;
restart the app. A 401 after sign-in on an older Supabase project means the token is HS256
and cannot be verified: add the JWT secret under **Advanced** (never a service-role key).
A 401 from Supabase means an expired session; sign out and in.

**Email or reset links go to the wrong address.** Supabase redirects only to
**Authentication > URL Configuration** entries; add the exact `http://127.0.0.1:47900/**`
and `http://<lan-ip>:47900/**` patterns. A `127.0.0.1` link opens the app only on the
computer; a `<lan-ip>` link works from a phone. For "Email not confirmed", click the link,
check spam, and resend; or disable **Confirm email**.

**A phone cannot connect.** Test from another device: `curl http://<lan-ip>:47900/health`.
If that works, check the browser and account; if not, check in order: LAN toggle on, same
non-guest network, firewall allows 47900, no VPN, computer awake, IP unchanged.

**Sign-ups are closed.** "Signups not allowed" is expected after step 5. Sign in with the
owner account or add a user under **Authentication > Users**.

**Reset, back up, uninstall, update.** Close the app and rename the data folder for a full
reset, or copy it to back up (imported audio is inside). **Settings > Storage > Clear all
data** clears records, playlists and settings. Uninstall via `sudo apt remove
open-record-desktop` on Linux, deleting the AppImage, **Settings > Apps** on
Windows, or the Trash on macOS; the data folder usually survives. Windows and AppImage builds update in the
app. For `.deb` and macOS builds, install the newer build over the old one; the fixed address and
reused folder keep the library, imports and settings.

## Limits

- Unsigned installers: expect warnings. `.deb` and macOS builds update by reinstalling; Windows and
  AppImage builds update in the app. The
  server is LAN-only: never expose 47900; use
  [Public access](../README.md#public-access) for outside access.
- Remote search, streaming and saving need internet and the bundled yt-dlp. Stream links
  are IP-bound and expire, so remote playback works on the same network as the desktop,
  not from mobile data.
- Accounts and sync depend on your own Supabase project and quota. Open Record hosts no
  audio, accounts or relay, and no music beyond the bundled catalogue.
- You are responsible for having the rights to what you stream or save; see the music
  disclaimer in the [README](../README.md). The app is MIT licensed (see
  [LICENSE](../LICENSE)); sample media keep their own licences.
