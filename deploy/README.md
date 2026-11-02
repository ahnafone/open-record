# Open Record public HTTPS deployment runbook

**Prepared:** 2026-11-02
**Status:** artifacts prepared; **nothing in this runbook has been executed** as
part of preparing them. DNS, router, `ufw`, Caddy, systemd and Supabase are
**user-run** steps.

| Marker | Meaning |
| --- | --- |
| **USER-RUN (privileged)** | Needs `sudo`/root on the server host. |
| **USER-RUN (external)** | Needs the router, GoDaddy DNS, the Supabase dashboard, or a device outside the home LAN. |
| _(no marker)_ | Can be run from this repository by the user or an agent. |

This runbook is deliberately not a `.env` file: no token, database password,
service-role key, JWT secret or Supabase anon key is written here. Copy safe
values into `apps/server/.env` yourself.

---

## 1. Target values

| Item | Value |
| --- | --- |
| Public hostname | `open-record.uttarasoftware.ca` |
| GoDaddy A record | `open-record` -> `96.55.42.249`, TTL `600`, **no AAAA** |
| Server LAN address | `10.0.0.139` (DHCP reservation for `d8:43:ae:16:2d:5b`) |
| Public TCP forwards | `80` and `443` only, both to `10.0.0.139` |
| App listener | `0.0.0.0:8787` (private; LAN-only via `ufw`) |
| Public listener | Caddy only: `10.0.0.139:80` and `10.0.0.139:443` |
| Tailscale listener | `127.0.0.1:80` and `127.0.0.1:443` (leave alone) |
| App URL | `https://open-record.uttarasoftware.ca` |
| Cast media URL | `http://10.0.0.139:8787` (speakers stay on the LAN) |

The public IPv4 address is **dynamic** unless the ISP says otherwise. See
[section 17](#17-dynamic-public-ip).

## 2. Topology and port rules

```
Internet
  |  TCP 80/443 only
  v
Router (port forwards 80/443 -> 10.0.0.139; 8787 NOT forwarded)
  |
  v
10.0.0.139
  |-- Caddy :80/:443  --> reverse_proxy 127.0.0.1:8787
  |                         Open Record server (systemd user unit)
  |-- 127.0.0.1:80/443     Tailscale Serve (separate; do not disturb)
  |
  +-- LAN phones/Cast speakers --> http://10.0.0.139:8787 (direct, no TLS)
```

- Caddy is the **only** process listening on a public address.
- `8787` is **never** forwarded by the router. `ufw` allows it only from
  `10.0.0.0/24`.
- The app listens on `0.0.0.0:8787` so LAN phones and Cast speakers can use
  `http://10.0.0.139:8787`; Caddy reaches the same port over loopback. The
  firewall, not the bind address, keeps it private.
- Cast uses the LAN HTTP URL on purpose: a speaker fetching through
  `https://open-record.uttarasoftware.ca` would depend on router hairpin/NAT
  loopback and would send LAN audio through the internet.

## 3. Prerequisites

- Ubuntu/Debian host with `sudo`, systemd, and a checkout at
  `~/Github/open-record`.
- Node 24 via nvm, with `~/.local/bin/node` symlinked to it. The systemd unit
  runs `~/.local/bin/node`; after an nvm upgrade, repoint it:
  `ln -sf "$(command -v node)" ~/.local/bin/node`.
- `yt-dlp` on `PATH` (`pipx install yt-dlp`) and ffmpeg 6+
  (`sudo apt install ffmpeg`).
- Outbound HTTPS for ACME, yt-dlp and ffmpeg; **inbound TCP 80 and 443** from
  the internet.
- Caddy **2.8 or newer** from the official repository (see section 9). Ubuntu's
  packaged Caddy may be 2.6.2 and is deliberately avoided.
- Admin access to GoDaddy DNS, the router, and the Supabase project.
- An owner Supabase account already created (section 13) before DNS goes live.
- The public IPv4 is not behind carrier-grade NAT. If the router's WAN address
  is not `96.55.42.249` (or is in `100.64.0.0/10`), inbound forwarding cannot
  work and the ISP must provide a public address.

## 4. Step 1 - DNS at GoDaddy (external)

**USER-RUN (external).** In GoDaddy's DNS editor for `uttarasoftware.ca`:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| `A` | `open-record` | `96.55.42.249` | `600` |

Delete any existing `AAAA` for `open-record`. A stale AAAA lets IPv6 clients
bypass the working IPv4 path and fail.

Verify from a machine outside the home LAN (or any resolver):

```sh
dig +short A open-record.uttarasoftware.ca
dig +short AAAA open-record.uttarasoftware.ca   # must print nothing
dig +short A open-record.uttarasoftware.ca @1.1.1.1
```

Wait for the TTL before expecting certificate issuance to succeed. GoDaddy may
label the name as just `open-record` and append `.uttarasoftware.ca`
automatically; do not enter the full hostname twice.

## 5. Step 2 - Router and DHCP reservation (external)

**USER-RUN (external).**

1. Add a DHCP reservation: MAC `d8:43:ae:16:2d:5b` -> `10.0.0.139`.
2. Forward **TCP 80** -> `10.0.0.139:80` and **TCP 443** ->
   `10.0.0.139:443`. Source "any".
3. **Do not** forward `8787`, and remove any existing `8787` forward, DMZ host,
   port trigger or UPnP mapping that would expose it. The server is not a DMZ
   host.
4. Leave router NAT loopback/hairpin as it is; section 12 tests it. Do not
   "fix" hairpin by forwarding `8787`.

Confirm after applying: the router's port-forward list contains exactly 80 and
443 for this host.

## 6. Step 3 - Host firewall (privileged)

**USER-RUN (privileged).** On the server:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'ssh'
sudo ufw allow 80/tcp comment 'caddy http'
sudo ufw allow 443/tcp comment 'caddy https'
sudo ufw allow from 10.0.0.0/24 to any port 8787 proto tcp comment 'open-record LAN only'
sudo ufw enable
sudo ufw status numbered
```

Expected `8787` rule:

```
8787/tcp  ALLOW  10.0.0.0/24
```

There must be **no** `ALLOW ANYWHERE` rule for `8787`. If the LAN subnet is not
`10.0.0.0/24`, use the real subnet, not a wider one. Do not lock yourself out:
keep 22/tcp allowed before enabling `ufw`.

## 7. Step 4 - Check the Tailscale bind conflict

Tailscale Serve already binds `127.0.0.1:80` and `127.0.0.1:443` on this host.
Caddy therefore binds `10.0.0.139`, never `:80`/`:443` (wildcard). This is why
[`deploy/Caddyfile`](./Caddyfile) has **two** site blocks:

- the hostname block (implicit HTTPS on `:443`), and
- an explicit `http://open-record.uttarasoftware.ca` block that redirects to
  HTTPS with a plain `301`.

Both blocks carry `bind 10.0.0.139`. Without the explicit HTTP block, Caddy's
automatic HTTP-to-HTTPS redirect server binds the wildcard `:80` and collides
with Tailscale's `127.0.0.1:80`. Do not delete the HTTP block to "simplify" the
file; that reintroduces the collision.

Check:

```sh
ss -ltnp | grep -E ':(80|443|8787)\b' || true
```

Before Caddy starts you should see Tailscale on `127.0.0.1:80/443` and the app
on `0.0.0.0:8787`. After Caddy starts, `10.0.0.139:80` (the explicit redirect
site) and `10.0.0.139:443` (the HTTPS site) must be added, and Tailscale must
still own `127.0.0.1:80/443`. If Caddy reports "address already in use", fix the
`bind` lines in **both** site blocks; do not stop Tailscale.

## 8. Step 5 - Build and configure the app

From `~/Github/open-record`:

```sh
node --version                 # must be v24.x
npm ci
npx nx build app
npx nx build server
```

Create the private environment file (never commit it):

```sh
cp apps/server/.env.example apps/server/.env
chmod 600 apps/server/.env
```

Public-server values (fill in the Supabase anon key from the dashboard; it is
public, but do not commit `.env`):

```dotenv
PORT=8787
HOST=0.0.0.0
PUBLIC_URL=https://open-record.uttarasoftware.ca
TRUST_PROXY=127.0.0.1
CAST_MEDIA_BASE_URL=http://10.0.0.139:8787
CAST_CACHE_MB=512
CAST_UPLOAD_MAX_MB=200
LOG_LEVEL=info
CORS_ORIGINS=https://open-record.uttarasoftware.ca,http://localhost:4200,capacitor://localhost,http://localhost
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<public anon key>

# Optional, server-side only, only for legacy HS256 projects. Prefer asymmetric
# signing keys/JWKS and leave this unset.
# SUPABASE_JWT_SECRET=<at least 32 characters>

# Optional YouTube cookies; keep outside the repo and chmod 600.
# YTDLP_COOKIES_FILE=/home/<you>/cookies.txt
```

Notes:

- `WEB_DIR` is set by the systemd unit to `dist/apps/app/browser`; do not
  override it in `.env`.
- `PUBLIC_URL` is what the banner/QR show and is served to the app.
- `CAST_MEDIA_BASE_URL` is the **LAN HTTP** address, not the public HTTPS URL.
- `TRUST_PROXY=127.0.0.1` trusts `X-Forwarded-For` only from Caddy. Never use
  `TRUST_PROXY=true` on this server: direct LAN clients could spoof their IP
  and evade rate limits.
- The bearer token is generated at `~/.config/open-record/token` (mode 0600).
  Do not paste it into `.env`, docs, screenshots or chat. `OPEN_RECORD_TOKEN`
  is only for explicitly choosing your own token.
- **Never put the Supabase database password or a `service_role` key in this
  file.** The server needs neither. The anon key is public by design.
- Keep `apps/server/.env`, `~/.config/open-record/` and any cookies file at
  mode `0600`, and out of the repository.

Stop any detached `server:up` instance before enabling the unit; both use 8787:

```sh
npm run server:up -- --stop
ss -ltnp | grep ':8787' || echo '8787 is free'
```

## 9. Step 6 - Install current Caddy (privileged)

**USER-RUN (privileged).** Use Caddy's official apt repository, not Ubuntu's
older package:

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
caddy version
apt-cache policy caddy
```

`caddy version` must report `v2.8.0` or newer. If an older Ubuntu package is
still selected, remove it and install again from the official repo:

```sh
sudo apt remove -y caddy      # keeps configuration files
sudo apt update
sudo apt install -y caddy
caddy version
```

Do not `purge` unless you intend to delete the existing Caddy configuration.

## 10. Step 7 - Install and start the Caddyfile (privileged)

**USER-RUN (privileged).** From the repository root:

```sh
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%F-%H%M)
sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable caddy
sudo systemctl restart caddy
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy -n 100 --no-pager
```

The first HTTPS request triggers ACME issuance. Watch it:

```sh
sudo journalctl -u caddy -f | grep -iE 'certificate|acme|error|challenge'
```

Certificates live under `/var/lib/caddy/.local/share/caddy/certificates/`.
Issuance needs DNS to point at the public IPv4 and the router's 80/443
forwards to be active. If DNS or forwarding is not ready yet, Caddy keeps
retrying; fix DNS/forwarding and restart it. `caddy validate` checks the
configuration only, not DNS, port forwarding or certificate issuance.

## 11. Step 8 - Run the app as a systemd user unit

The unit is [`deploy/open-record-server.service`](./open-record-server.service).
Install it as a user unit (the symlink matters):

```sh
mkdir -p ~/.config/systemd/user
ln -sf "$PWD/deploy/open-record-server.service" ~/.config/systemd/user/
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now open-record-server
systemctl --user status open-record-server --no-pager
journalctl --user -u open-record-server -f
```

The unit sets `WorkingDirectory`, `NODE_ENV=production`, `PATH`, `HOST=0.0.0.0`
and `WEB_DIR=.../dist/apps/app/browser`, and loads the rest from
`apps/server/.env`. `loginctl enable-linger` is what keeps it running after
logout and starts it at boot.

Confirm the app independently of Caddy:

```sh
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://10.0.0.139:8787/health
```

Then confirm through Caddy:

```sh
curl -fsS https://open-record.uttarasoftware.ca/health
```

A `502` means Caddy is fine but the app is not listening; check the user unit
and `HOST`/`PORT`. A TLS error means issuance has not completed yet (section
10 and section 12).

## 12. Verification

Run these from the appropriate machine. Several are **USER-RUN (external)**.

### 12.1 HTTP redirects to HTTPS

```sh
curl -sSI http://open-record.uttarasoftware.ca/health | sed -n '1,6p'
```

Expect `301` (the explicit HTTP site's `redir ... permanent`) and
`location: https://open-record.uttarasoftware.ca/health`. No body is served
over HTTP. Caddy's implicit redirect would be `308`; this deployment uses the
explicit `301` so the `:80` listener stays bound to `10.0.0.139` instead of the
wildcard. Both are permanent redirects.

### 12.2 Certificate and SAN

```sh
openssl s_client -connect open-record.uttarasoftware.ca:443 \
  -servername open-record.uttarasoftware.ca </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```

Expect issuer `Let's Encrypt` (Caddy falls back to ZeroSSL only if Let's
Encrypt is unavailable), a current `notAfter`, and exactly
`DNS:open-record.uttarasoftware.ca` in the SAN. The certificate must not be
self-signed and must not be for a different hostname.

### 12.3 TLS floors

```sh
for v in -tls1_2 -tls1_3; do
  printf '%s: ' "$v"
  openssl s_client -connect open-record.uttarasoftware.ca:443 \
    -servername open-record.uttarasoftware.ca "$v" </dev/null 2>/dev/null \
    | grep -m1 'Protocol'
done
```

Both must succeed. Then confirm TLS 1.1 fails:

```sh
openssl s_client -connect open-record.uttarasoftware.ca:443 \
  -servername open-record.uttarasoftware.ca -tls1_1 </dev/null 2>&1 \
  | grep -iE 'alert|error|Protocol'
```

OpenSSL 3 clients may refuse TLS 1.1 locally before contacting the server; the
result is still "no TLS 1.1". Do not lower the floor to make an old client work.

### 12.4 Security headers

```sh
curl -sSI https://open-record.uttarasoftware.ca/health \
  | grep -iE '^(server|strict-transport-security|x-content-type-options|referrer-policy|permissions-policy):'
```

Expect `strict-transport-security: max-age=86400`,
`x-content-type-options: nosniff`,
`referrer-policy: strict-origin-when-cross-origin`,
`permissions-policy: camera=(self)`, and **no** `server:` header.

### 12.5 `/health`, `/app-config` and `/ping`

```sh
curl -fsS https://open-record.uttarasoftware.ca/health
# {"status":"ok"}

curl -fsS https://open-record.uttarasoftware.ca/app-config | python3 -m json.tool
# Only supabaseUrl and supabaseAnonKey (or nulls). No service_role key.

curl -sS -o /dev/null -w 'no token:   %{http_code}\n' \
  https://open-record.uttarasoftware.ca/ping
# 401

TOKEN=$(cat ~/.config/open-record/token)
curl -sS -o /dev/null -w 'with token: %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  https://open-record.uttarasoftware.ca/ping
# 200
```

Never print `$TOKEN` itself; the commands above only test the status code. If
`/app-config` returns nulls, `SUPABASE_URL`/`SUPABASE_ANON_KEY` are unset or the
unit was not restarted.

### 12.6 The web app is served

```sh
curl -fsSI https://open-record.uttarasoftware.ca/ | sed -n '1,8p'
```

Expect `200` and `content-type: text/html` for
`dist/apps/app/browser/index.html`. The web app itself loads without a token;
API calls still need the bearer token.

### 12.7 Range request returns 206 (cast relay)

Range support lives on `GET /cast/relay/:token`, so this needs a live cast
relay URL. Start playing a **catalog/local** track to a Cast device, then copy
the `/cast/relay/<token>` URL from the browser's Network panel or the session
welcome. That URL is a short-lived bearer credential: do not paste it into
chat, issues or screenshots.

```sh
RANGE_URL='https://open-record.uttarasoftware.ca/cast/relay/<token>'
curl -sS -D - -o /dev/null -H 'Range: bytes=0-1023' "$RANGE_URL"
```

Expect `HTTP/2 206`, `accept-ranges: bytes`, and
`content-range: bytes 0-1023/<size>`. A `200` means Range was not honored; a
`404` means the relay token expired or was wrong. A `502` points at the app,
not Caddy.

### 12.8 WebSocket upgrade returns 101

The `/session` handshake is intentionally public; account auth happens in the
first `hello` frame, so a 101 here proves the upgrade path through Caddy.

```sh
curl --http1.1 -sS -i -N --max-time 3 \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://open-record.uttarasoftware.ca/session | sed -n '1,6p'
```

Expect `HTTP/1.1 101 Switching Protocols`. The server closes the socket after
the hello timeout; `--max-time 3` is expected to end the command. Then confirm
in the app that a signed-in device connects and syncs.

### 12.9 Port 8787 is closed from outside

**USER-RUN (external).** From a phone with Wi-Fi off (or another network):

```sh
curl --connect-timeout 5 -sS http://open-record.uttarasoftware.ca:8787/health
curl --connect-timeout 5 -sS http://96.55.42.249:8787/health
```

Both must time out or be refused. From the home LAN, the same port must work:

```sh
curl -fsS http://10.0.0.139:8787/health
```

Optional external scan from a VPS:

```sh
nmap -Pn -p 80,443,8787 open-record.uttarasoftware.ca
```

Expect `80` and `443` open, `8787` closed/filtered. If 8787 is open, stop and
remove the forward/UPnP rule before continuing.

### 12.10 Hairpin / NAT loopback

From the home LAN:

```sh
curl -fsS https://open-record.uttarasoftware.ca/health
```

Some routers cannot hairpin; a timeout here is a router limitation, not a Caddy
failure. Prove Caddy locally without hairpin:

```sh
curl -fsS --resolve open-record.uttarasoftware.ca:443:10.0.0.139 \
  https://open-record.uttarasoftware.ca/health
```

If hairpin is unavailable, see [section 14](#14-hairpin-and-split-dns). The
phone app on home Wi-Fi can always use `http://10.0.0.139:8787`; the public URL
is for cellular and other networks.

### 12.11 Cellular playback caveat

`/stream` may hand the client a source URL that is tied to the server's egress
IP and/or expires quickly. A track can therefore play on home Wi-Fi and return
`403` on cellular for reasons unrelated to Caddy, TLS, or the token. Test more
than one source, and prefer a source that the phone can fetch directly. This is
a per-source limitation, not something to "fix" by opening 8787.

## 13. Supabase public settings (external)

**USER-RUN (external).** Do this **before** DNS goes live, so no stranger can
create an account on the public URL.

1. **Owner account first.** Sign up in the app/web with the owner email and
   complete confirmation. Keep that account.
2. **Disable public signups.** Authentication -> Providers/Email: turn off
   "Allow new users to sign up".
3. **Disable anonymous sign-ins.** Authentication -> Providers/Settings: turn
   off anonymous sign-ins.
4. **Site URL and redirects.** Authentication -> URL Configuration:
   - Site URL: `https://open-record.uttarasoftware.ca`
   - Additional redirect URLs:
     `https://open-record.uttarasoftware.ca/**`,
     `http://localhost:4200/**` (local web dev),
     `capacitor://localhost` (iOS Capacitor),
     `http://localhost` (Android Capacitor).
5. **RLS.** Enable Row Level Security on every table the app reads or writes,
   with policies based on `auth.uid()`. Test with the anon key: it must not be
   able to read or write another user's rows. Storage buckets should stay
   private unless a feature explicitly needs public objects.
6. **Keys.** Project Settings -> API: the `anon` key is public and is what
   `/app-config` serves. The `service_role` key and the database password must
   **never** be placed in `apps/server/.env`, the app bundle, the desktop
   config, or this repository. The server does not need either.
7. **JWT signing.** Prefer asymmetric signing keys (verified through
   `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`). Only legacy HS256 projects
   need `SUPABASE_JWT_SECRET`, and it stays server-side in the 0600 `.env`.
8. **Rate limiting / abuse.** Supabase applies auth rate limits; also consider
   fail2ban or router/host rate limiting for SSH. The app's own
   `RATE_LIMIT_MAX` and `RESOLVE_RATE_LIMIT_MAX` still apply behind Caddy.
9. Re-check `/app-config` after saving:

```sh
curl -fsS https://open-record.uttarasoftware.ca/app-config | python3 -m json.tool
```

The URL must be the production project, the anon key must match it, and no
`service_role` value may appear.

## 14. Hairpin and split DNS

Hairpin (NAT loopback) lets a LAN device reach the public hostname through the
router. It is convenient but not guaranteed. Options, in order:

1. **Do nothing.** Use `https://open-record.uttarasoftware.ca` everywhere that
   works, and `http://10.0.0.139:8787` on home Wi-Fi when hairpin fails.
2. **Split DNS (best for phones on home Wi-Fi).** Add a local DNS record on the
   router or Pi-hole: `open-record.uttarasoftware.ca` -> `10.0.0.139`. The
   hostname still matches Caddy's certificate, and traffic stays on the LAN.
   Test with `curl --resolve` first (section 12.10).
3. **Public DNS override** is not recommended; it affects every client.

Do not enable router "NAT reflection" workarounds that expose 8787, and do not
change Caddy to bind the wildcard address to make hairpin work.

## 15. Logs and monitoring

```sh
# Caddy (public listener, ACME, TLS errors)
sudo journalctl -u caddy -f
sudo systemctl status caddy --no-pager
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# Open Record (requests, yt-dlp, cast)
journalctl --user -u open-record-server -f
systemctl --user status open-record-server --no-pager
```

- `LOG_LEVEL=info` is the production default. Avoid `debug` for long periods:
  it is noisier and may include more request detail.
- **Access logging is off in `deploy/Caddyfile`.** `/cast/relay/<token>` is a
  bearer credential in the URL. If you enable access logs later, use Caddy
  2.8+'s `log_skip` (the old `skip_log` name was renamed) together with a
  `log` directive:
  `log`, `@relay path /cast/relay/*`, `log_skip @relay`.
  Never add a bare `log`: it writes relay tokens to disk.
- The app's request logger redacts `/cast/relay/<token>`, but the startup
  banner contains the bearer token and the pairing link, and journald captures
  it. Restrict journal access on a shared host. If you do not need the banner,
  set `OPEN_RECORD_QUIET_STARTUP=1` (the desktop does this automatically) and
  read the token from `~/.config/open-record/token` instead.
- Rotate the token by stopping the unit, moving/removing
  `~/.config/open-record/token`, and starting it again; the server generates a
  new token. Re-pair every phone/desktop afterwards. Never publish the token.
- Caddy stores certificates and ACME state under
  `/var/lib/caddy/.local/share/caddy/`; back that directory up if you want to
  avoid re-issuance after a rebuild.

## 16. Rollback

**USER-RUN (privileged/external).** In reverse order:

```sh
# 1. Stop the app user unit
systemctl --user disable --now open-record-server
rm -f ~/.config/systemd/user/open-record-server.service
systemctl --user daemon-reload

# 2. Restore the previous Caddy config (or stop Caddy entirely)
sudo cp /etc/caddy/Caddyfile.bak.<timestamp> /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
# Full rollback instead:
# sudo systemctl disable --now caddy

# 3. Remove the temporary firewall rules (keep 22/tcp)
sudo ufw status numbered
sudo ufw delete <8787-rule-number>
sudo ufw delete <443-rule-number>
sudo ufw delete <80-rule-number>
```

Then **USER-RUN (external)**:

4. Remove the router's TCP 80/443 forwards; confirm 8787 is still not forwarded.
5. Point the GoDaddy A record back to the previous address (or delete it). TTL
   600 means clients recover within about 10 minutes after propagation.
6. Do not delete Supabase data, the generated token, the cast cache or
   `apps/server/.env` unless you intend to lose pairings/settings. Re-enable
   Supabase signups only if you deliberately want a public signup flow again.

Rolling back Caddy does not stop the app; it only removes public HTTPS. Rolling
back the app unit leaves Caddy returning `502` until it is stopped too.

## 17. Dynamic public IP

The A record is TTL 600, so an ISP address change takes effect within minutes
after you update DNS. Options:

- **Manual:** compare the router's WAN IPv4 with
  `dig +short A open-record.uttarasoftware.ca` after any outage; update the
  GoDaddy A record if they differ.
- **DDNS:** use the router's DDNS client or a Cloudflare-hosted zone with an API
  token that can edit only the `open-record` A record. This repository has no
  DDNS automation and stores no provider credentials.
- **Cloudflare proxy caveat:** this setup expects DNS-only (grey cloud). An
  orange-cloud proxy terminates TLS at Cloudflare and changes ACME; do not
  enable it without switching Caddy to DNS-01 or an origin certificate.
- **CGNAT:** if the WAN address is in `100.64.0.0/10` or differs from the
  published A record no matter what, inbound forwarding cannot work. Ask the
  ISP for a public IPv4; a tunnel (Tailscale/Cloudflare Tunnel) is the
  alternative, but it is outside this runbook.

## 18. Security rules and "do nots"

- **Do not port-forward 8787.** Not on the router, not via UPnP, not with a DMZ
  host. It bypasses Caddy and exposes the bearer token over plain HTTP.
- **Caddy is the only public listener.** Keep its `bind 10.0.0.139`; do not bind
  `:80`/`:443` wildcard while Tailscale owns `127.0.0.1`.
- **Do not set `TRUST_PROXY=true`.** Use `127.0.0.1` so only Caddy's header is
  trusted. Direct LAN clients must not be able to spoof `X-Forwarded-For`.
- **Do not put secrets in docs, screenshots, issues or chat.** The bearer token,
  `SUPABASE_JWT_SECRET` (if used), cookies file, database password and
  `service_role` key are all secret. The anon key is public by design.
- **Do not commit `.env`.** Keep it `0600`; keep `~/.config/open-record/`
  `0700`/`0600`; keep any cookies file outside the repo and `0600`.
- **A signed-in YouTube account on a public IP is a risk.** `YTDLP_COOKIES_FILE`
  is optional; if used, expect account-level rate limits/blocks and keep it
  private.
- **CORS is not authentication.** The token/Supabase auth still protects the
  API; `CORS_ORIGINS` only limits browser origins.
- **Rotate exposed secrets.** If the Supabase database password was ever
  exposed, rotate it in the dashboard; it is not needed by this server.
- **Backups.** The app data directory holds the token, cast secret and upload
  cache; the Caddy data directory holds certificates. Back up what you need
  before reinstalling.

## 19. What was and was not validated

- [`deploy/Caddyfile`](./Caddyfile) was validated with a downloaded **Caddy
  v2.11.7**: `caddy validate --config deploy/Caddyfile --adapter caddyfile`
  reported `Valid configuration`, and `caddy fmt` reports no changes.
  `caddy adapt` shows exactly two listeners, `10.0.0.139:443` (HTTPS site) and
  `10.0.0.139:80` (the explicit HTTP redirect site), with **no wildcard**
  `:80`/`:443` that could collide with Tailscale. The optional
  `log` + `@relay` + `log_skip @relay` example was validated separately (the
  pre-2.8 name `skip_log` was renamed to `log_skip`). `caddy validate` checks
  configuration only: no listener was started, no certificate was issued, and
  DNS/port forwarding were not exercised.
- [`apps/server/.env.example`](../apps/server/.env.example) parses with Node
  24's `--env-file`. It contains no real secrets.
- [`deploy/open-record-server.service`](./open-record-server.service) was
  checked with `systemd-analyze verify` on a temporary copy with `%h` expanded;
  it produced no warnings. `systemd-analyze --user verify` could not run in the
  preparation sandbox ("Failed to bind private socket"), so the user-manager
  runtime was not exercised. The unit remains a **user** unit and preserves
  `WEB_DIR`.
- No DNS, router, `ufw`, Caddy, systemd, Supabase or certificate step was run
  while preparing these artifacts. Nothing here claims the deployment is live.
