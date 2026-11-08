# Public hosting runbook

Hosts the Open Record server and web app at `https://open-record.uttarasoftware.ca` behind a Cloudflare Tunnel, with approval-gated accounts on Supabase. Host: `open-record.uttarasoftware.ca` (zone `uttarasoftware.ca`). Placeholders: `<ref>` (Supabase project ref), `<UUID>` (tunnel id), `<anon>` (anon / publishable key).

Shape of the deployment:

- The Node server listens on `127.0.0.1:8787` only. Nothing on the LAN or internet can reach it directly.
- `cloudflared` on the same host forwards `https://open-record.uttarasoftware.ca` to that port.
- Accounts are requested, not self-created. The admin approves requests; approval sends a Supabase invite.

Commands below use `npx supabase` (the repo's convention). Check flags against your installed CLI with `--help`.

---

## (a) Cloudflare account, domain, tunnel

1. **Account and zone.** Sign up at cloudflare.com, add `uttarasoftware.ca`, and point the registrar's nameservers at the two Cloudflare nameservers it gives you. (The whole `uttarasoftware.ca` zone must be on Cloudflare; copy existing DNS records, including mail, before switching nameservers.)
2. **Install cloudflared** on the host (Debian/Ubuntu, via the Cloudflare apt repo; other distros: download the binary from the cloudflared GitHub releases):
   ```bash
   sudo mkdir -p --mode=0755 /usr/share/keyrings
   curl -fsSL https://pkg.cloudflare.com/cloudflare-public-v2.gpg | sudo tee /usr/share/keyrings/cloudflare-public-v2.gpg >/dev/null
   echo 'deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update && sudo apt-get install -y cloudflared
   cloudflared --version
   ```
3. **Authorize and create the tunnel:**
   ```bash
   cloudflared tunnel login                      # browser; pick uttarasoftware.ca; writes ~/.cloudflared/cert.pem
   cloudflared tunnel create open-record         # prints <UUID>; writes ~/.cloudflared/<UUID>.json
   cloudflared tunnel route dns open-record open-record.uttarasoftware.ca
   ```
   `route dns` creates a proxied CNAME for `open-record.uttarasoftware.ca` pointing at the tunnel. Do not add an A record.
4. **Ingress config** `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <UUID>
   credentials-file: /home/<you>/.cloudflared/<UUID>.json

   ingress:
     - hostname: open-record.uttarasoftware.ca
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```
   The final catch-all rule is required.
5. **Test in the foreground** first: `cloudflared tunnel run open-record`. Then `curl -I https://open-record.uttarasoftware.ca/` should reach the server (it will fail until the server is running).
6. **Run as a systemd service.** The service reads `/etc/cloudflared/`, so copy the config and credentials there and point `credentials-file` at the copy:
   ```bash
   sudo mkdir -p /etc/cloudflared
   sudo cp ~/.cloudflared/config.yml ~/.cloudflared/<UUID>.json /etc/cloudflared/
   sudo sed -i "s|/home/<you>/.cloudflared/|/etc/cloudflared/|" /etc/cloudflared/config.yml
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   systemctl status cloudflared --no-pager
   ```
   Keep the credentials JSON private (`sudo chmod 600 /etc/cloudflared/<UUID>.json`). Anyone with it can run your tunnel.

## (b) Server environment (`apps/server/.env`, public mode)

Create the file from `apps/server/.env.example` and `chmod 600` it. It is git-ignored. Non-secret values only, apart from the token and JWT secret noted in the template:

```bash
HOST=127.0.0.1                          # loopback only: cloudflared is the sole way in
PORT=8787
PUBLIC_URL=https://open-record.uttarasoftware.ca
TRUST_CF_CONNECTING_IP=true             # cloudflared is the ONLY way in (no Caddy); real client IP for rate limits
TRUST_PROXY=127.0.0.1/8,::1             # cloudflared connects from loopback; trust only that
CORS_ORIGINS=https://open-record.uttarasoftware.ca
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon / publishable key>   # public by design
ADMIN_USER_ID=<admin auth user UUID>    # same value as the Supabase secret (step c)
REQUIRE_APPROVAL=true
SUPABASE_SERVICE_ROLE_KEY=<service_role key>  # SECRET, server-side only (see notes)
TURNSTILE_SITE_KEY=<turnstile site key>      # public; served to the web app. Secret goes to Supabase only
CAST_ENABLED=false                      # speakers cannot reach a loopback-bound server
WEB_DIR=dist/apps/app/browser           # path relative to the server's working directory, or absolute
```

Notes:

- `HOST=127.0.0.1` replaces the `0.0.0.0` used by the LAN/Caddy setup. With `0.0.0.0`, a LAN client could hit port 8787 directly and spoof `X-Forwarded-For`.
- `SUPABASE_SERVICE_ROLE_KEY` **is** required on the server when `REQUIRE_APPROVAL=true`: the server reads `access_requests` with it, so approval is enforced on each HTTP request and on open websockets within ~60 s of a revoke. Find it in the Supabase dashboard (Project Settings > API Keys > `service_role`). It bypasses Row Level Security, so keep it only in `apps/server/.env` (`chmod 600`), never in the web or desktop app, a log or a commit. Edge Functions get their own copy automatically.
- **Accepted limit:** a revoked user's Supabase access token stays valid for the Supabase REST API until it expires (about 1 hour by default). Banning the account stops token refresh. The REST API only returns that user's own rows under RLS, so the window is accepted; the Open Record server itself enforces the revoke within ~60 s.
- Do not set `SUPABASE_JWT_SECRET` on a current project (asymmetric signing keys are verified via JWKS).
- Start the server with `npm run server:dev` for a quick check, or through its systemd user unit for production.

## (c) Supabase hosted project

1. **Create the project** at supabase.com and note the project ref (`<ref>`) and the database password.
2. **Link and push migrations** from the repo root:
   ```bash
   npx supabase login
   npx supabase link --project-ref <ref>       # asks for the database password
   npx supabase db push --dry-run              # review: should list 20261107120000_access_requests
   npx supabase db push
   ```
3. **Lock down sign-in.** Dashboard > Authentication > Sign In / Providers:
   - **Email provider:** turn **off** "Allow new users to sign up". Invites still work with it off. This also stops email OTP / magic link from creating accounts (`POST /auth/v1/otp` with `create_user: true`). The exact label varies with dashboard version; search the Auth settings for "sign up".
   - **Confirm email:** turn **on**. `decide-access` treats an account with no `email_confirmed_at` as unconfirmed and deletes it on re-approval, so this must be on for the reset logic to mean what it says. Confirmation links go out through the SMTP setup in step c5.
   - **Anonymous sign-ins:** must stay **off**.
   - **OAuth providers** (Google, GitHub, Apple, etc.): must stay **off**. Any of them would create accounts without an approval.

   `supabase/config.toml` sets the same for local dev (`enable_signup = false`, `enable_anonymous_sign_ins = false`, `enable_confirmations` on for hosted).
4. **URL configuration.** Dashboard > Authentication > URL Configuration:
   - Site URL: `https://open-record.uttarasoftware.ca` (invite emails link here).
   - Redirect URLs: `https://open-record.uttarasoftware.ca/**`, `capacitor://localhost`, `http://localhost` (native shells).
5. **SMTP for invite emails.** Supabase's built-in mailer is for development only and heavily rate-limited. Dashboard > Authentication > Emails > SMTP Settings, enable custom SMTP with Resend (see step e):
   - Host `smtp.resend.com`, port `465` (SSL) or `587` (STARTTLS)
   - Username `resend`, password = Resend API key
   - Sender = the verified `MAIL_FROM` address
6. **Create the admin account by hand.** Dashboard > Authentication > Users > Add user > Create new user. Enter the admin's email and a strong password, and tick auto-confirm. Copy the user's **UID** (a UUID). That value is `ADMIN_USER_ID` in both the server `.env` and the Supabase secrets. Sign in as admin in the app with this password.
7. **Set function secrets.** Use the values from `supabase/functions/.env.example`. Either set them one by one:
   ```bash
   npx supabase secrets set \
     ADMIN_USER_ID=<admin UID> \
     ADMIN_EMAIL=<admin email> \
     TURNSTILE_SECRET=<turnstile secret key> \
     TURNSTILE_EXPECTED_HOSTNAME=open-record.uttarasoftware.ca \
     REQUEST_IP_SALT="$(openssl rand -hex 32)" \
     RESEND_API_KEY=<resend api key> \
     MAIL_FROM="Open Record <access@uttarasoftware.ca>" \
     PUBLIC_APP_URL=https://open-record.uttarasoftware.ca
   ```
   or copy `supabase/functions/.env.example` to `supabase/functions/.env`, fill it in, and run `npx supabase secrets set --env-file supabase/functions/.env`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically; do not set them. `REQUEST_IP_SALT` is generated once; changing it later only resets the per-source counts.
8. **Deploy the functions.** `verify_jwt` for each function comes from `supabase/config.toml`. Deploy them one at a time:
   ```bash
   npx supabase functions deploy request-access
   npx supabase functions deploy list-access
   npx supabase functions deploy decide-access
   ```
   Endpoints: `https://<ref>.supabase.co/functions/v1/<name>`. `request-access` is public; the other two need the admin's signed-in JWT.

   **Client contract for `request-access`:** it returns `{"status": "pending"}` for every successful request, whether the address is new, pending, approved, denied or revoked. The client must not try to learn an address's status from it. The app's other status labels (approved, denied, revoked) are kept in the UI but are never returned to a visitor, so they are harmless. Errors are 400 (bad input), 403 (Turnstile failed), 429 (per-source or pending-queue limit) and 500.

## (d) Turnstile (bot check on access requests)

1. Dashboard (Cloudflare) > Turnstile > **Add widget**.
2. Name: `open-record`. Hostnames: `open-record.uttarasoftware.ca` (add `localhost` only if you test the widget locally). Widget mode: **Managed**.
3. Copy the **Site key** to `TURNSTILE_SITE_KEY` in `apps/server/.env`. It is public and ends up in the browser.
4. Copy the **Secret key** to the Supabase secret `TURNSTILE_SECRET` (step c7). Never put it in the server `.env` or the web app.
5. Set the Supabase secret `TURNSTILE_EXPECTED_HOSTNAME=open-record.uttarasoftware.ca` (step c7). The function then rejects tokens minted for any other hostname.

Tokens are single-use and expire after about five minutes; the request form must fetch a fresh one each submit. The function calls siteverify with a 5 s timeout and passes the client IP as `remoteip`.

## (e) Resend (transactional mail)

1. Sign up at resend.com. Dashboard > Domains > **Add domain**: `uttarasoftware.ca` (or a subdomain such as `mail.uttarasoftware.ca`).
2. Add the DNS records Resend shows (SPF/DKIM TXT, plus MX/return-path if listed) in the Cloudflare DNS zone. Set them to **DNS only** (grey cloud). Wait until Resend shows the domain as verified.
3. Dashboard > API Keys > create a key with **Sending access**. This is `RESEND_API_KEY` (Supabase secret) and the SMTP password in (c5).
4. `MAIL_FROM` must use the verified domain, e.g. `Open Record <access@uttarasoftware.ca>`.

Mail sent:

- Admin notification for a new request. At most one per 10 minutes across all requests; the dashboard shows the queue either way.
- "Already approved" notice when someone asks for access with an approved address. At most one per address per hour. Nothing is sent for pending, denied or revoked addresses.
- Approval notice (existing confirmed accounts only; new accounts get the Supabase invite).
- Denial and revoke notices.

## (f) Throttles and limits

Two separate things:

- **This zone (`open-record.uttarasoftware.ca`):** covers the Node server, which sits behind the tunnel. Rate-limiting rules live in Security > WAF > Rate limiting rules. Availability depends on the Cloudflare plan. Starting values, tune against real traffic in Security > Events:
  - `http.request.uri.path starts_with "/search"`: 20 requests per 1 minute per IP, mitigation: block for 10 minutes.
  - `http.request.uri.path starts_with "/stream"`: 300 requests per 1 minute per IP, mitigation: managed challenge. Audio range requests are chatty, so keep this generous.
  - Everything else: 600 requests per 1 minute per IP (the server's own app-wide limit is `RATE_LIMIT_MAX`, default 600).
- **Supabase Edge Functions (`<ref>.supabase.co`):** these are **not** behind your Cloudflare zone, so the rules above do not apply to them. Protection for `request-access` is:
  - Turnstile, with the client IP passed as `remoteip` and the hostname checked.
  - A per-source throttle: more than 5 request rows from one hashed source in the last hour returns 429. The source is the IP from `cf-connecting-ip`, else the first `x-forwarded-for` entry, salted with `REQUEST_IP_SALT`. The raw IP is never stored. The count is over rows, so repeats of an existing address do not add to it, but the throttle still applies to them while the source is over the limit.
  - A global cap of 500 pending requests (429). This is a count of the current queue, not per hour. It is left as is, because the admin clears the queue regularly. It is also a denial-of-service lever: anyone who can submit requests can fill the queue to 500 and then refuse every new legitimate request until the admin clears it. Clear the queue (deny the spam) promptly when this happens.
  - Admin-notification and approved-notice cooldowns (see (e)).

  Limits and caveats:
  - Turnstile, the per-source throttle and the cooldowns are best-effort. The Edge gateway is not behind Cloudflare, so `cf-connecting-ip` and `x-forwarded-for` are set by the client. Per-IP throttling can be bypassed by header rotation: sending a new `cf-connecting-ip` or `x-forwarded-for` value on each request gives a fresh source bucket every time. An attacker who rotates headers, IPs or addresses is not stopped by the per-source throttle alone. Turnstile and the pending cap are the real limits here.
  - If you need edge rate limits on those routes, put a custom domain for Supabase functions behind Cloudflare; that is a separate change.

## (g) Verification checklist

Network:

- [ ] `dig +short open-record.uttarasoftware.ca` returns Cloudflare-owned addresses only (or `<UUID>.cfargotunnel.com` via CNAME). It never returns your home or LAN IP.
- [ ] `curl -I http://<LAN-IP>:8787/` from another device on the LAN is refused or times out.
- [ ] `curl -I http://127.0.0.1:8787/` from the host succeeds.
- [ ] `curl -I https://open-record.uttarasoftware.ca/` returns 200 with the web app.
- [ ] Server logs show the real client address for requests, not `127.0.0.1` for everyone (per-client rate limits depend on this).

Supabase sign-up lockdown (run each; every one must FAIL to create an account):

- [ ] Password signup is refused:
  ```bash
  curl -s -X POST "https://<ref>.supabase.co/auth/v1/signup" \
    -H "apikey: <anon>" -H "content-type: application/json" \
    -d '{"email":"probe-signup@example.com","password":"change-me-123"}'
  ```
  Expect an error such as `signup_disabled`, not a `user` object.
- [ ] Email OTP cannot create an account for an unknown address:
  ```bash
  curl -s -X POST "https://<ref>.supabase.co/auth/v1/otp" \
    -H "apikey: <anon>" -H "content-type: application/json" \
    -d '{"email":"probe-unknown@example.com","create_user":true}'
  ```
  Expect an error such as `signups_disabled` (or `otp_disabled`). Then confirm in Dashboard > Authentication > Users that no `probe-unknown@` user exists.
- [ ] OAuth providers and anonymous sign-ins are disabled: Dashboard > Authentication > Sign In / Providers shows them off. Both must stay off.
- [ ] `curl -s "https://<ref>.supabase.co/rest/v1/access_requests?select=*" -H "apikey: <anon>"` returns an error or `[]`, never rows.
- [ ] Email confirmations are on: Dashboard > Authentication > Sign In / Providers > Email > "Confirm email" is on.
- [ ] `list-access` with a non-admin signed-in JWT returns 403; with no token, 401.

End-to-end flow:

- [ ] Request access from the web app with a real Turnstile token. Response: `pending`. Admin email arrives.
- [ ] Request a second address within 10 minutes: response `pending`, no second admin email.
- [ ] Admin screen (signed in as the admin) lists the requests as pending.
- [ ] Approve: the requester gets the Supabase invite, sets a password, and signs in.
- [ ] Repeat the request for the approved address: response is `pending` (not the status), and the requester gets the "already have access" email. A second repeat within an hour sends nothing.
- [ ] Revoke: the server refuses the user within ~60 s (HTTP and open websockets). The user's Supabase access token stays valid until it expires (about 1 hour) for the Supabase REST API only, which is accepted. The account cannot refresh its token. Sign-in attempts fail.
- [ ] Approve again (from revoked): the user can sign in again with their existing password, and gets the "access approved" email.
- [ ] Deny a new request: the requester gets the denial email and cannot sign in. Repeat requests for it return `pending` and send nothing.
- [ ] Admin account: deny or revoke on the admin's own request is refused with 409.
- [ ] Unconfirmed account: an invite that was never accepted, then approved again, is replaced with a fresh invite (the old account is deleted first). An unconfirmed account that has signed in before is not deleted: approve returns 409 and the account must be resolved in the dashboard.

## (h) Security and legal note

- The download pipeline uses tools such as yt-dlp against sites (YouTube included) whose terms generally prohibit downloading. Running a public instance for other people multiplies that risk: copyright complaints, the host's IP being blocked or banned by the source, and possible account action against any cookies you supply.
- The approval gate limits who can use the service, not what it does. Keep the instance invite-only, do not advertise it, and treat `cookies.txt` as a credential (never commit it; keep it outside the repo; `chmod 600`).
- Keep `apps/server/.env` (`chmod 600`), `supabase/functions/.env`, and the Cloudflare credentials JSON out of git and out of logs. Rotate the Resend key, Turnstile secret, `REQUEST_IP_SALT`, and any leaked token immediately if exposed.
- Rotate `ADMIN_USER_ID`'s password regularly; the admin account is the only way to approve access.
