# v2: Backend

Everything that needs a server: accounts, sync, realtime collaboration, hardening of the downloader that v1 already ships as a self-hosted server ([downloader-server.md](downloader-server.md)). Builds on v1 interfaces (`MusicSourceProvider`, storage port, role logic).

## Goals

- [ ] Accounts and sign-in
- [ ] Sync library/playlists across devices (offline-first, v1 local store stays source of truth on device)
- [ ] Realtime collaborative playlists; Collaborators screen goes live
- [ ] Harden and multi-user the existing downloader server (see below)
- [ ] Cloud storage for user-owned uploads (optional)

## Backend options

| | Supabase | Firebase | Custom NestJS (in Nx repo) |
|---|---|---|---|
| Auth | Built in | Built in | Build/integrate (e.g. Passport) |
| Data | Postgres, row-level security | Firestore (NoSQL) | Postgres + ORM |
| Realtime | Realtime channels | Native listeners | WebSockets (build) |
| Storage | Built in | Built in | S3-compatible |
| Lock-in | Low (open source, self-hostable) | High | None |
| Effort | Low | Low | High |
| Custom jobs (downloader, exists as Fastify) | Edge functions / separate service | Cloud Functions | Native fit |

**Recommendation:** Supabase for auth, Postgres (RLS enforces Owner/Editor/Viewer), realtime and storage. The downloader already exists as a small Fastify app (`apps/server`); keep it as a separate service for long-running jobs and put it behind the same accounts instead of rewriting it in NestJS. Reason: relational playlist/membership data fits Postgres, roles map cleanly to RLS, and open source keeps self-hosting possible. Confirm with a short spike before committing.

## Auth and privacy

- [ ] Email + OAuth providers; anonymous local use remains possible
- [ ] Roles Owner/Editor/Viewer enforced server-side (RLS), not only in the client
- [ ] Private/Public playlist visibility enforced server-side
- [ ] Minimal data collection; export and delete-account flows
- [ ] Privacy policy and store data-safety/privacy labels
- [ ] Security tests (permanent suite): role enforcement, visibility, auth bypass

## Sync

- [ ] Server schema: users, tracks (metadata refs), playlists, members, library items
- [ ] Offline queue, last-write-wins per field with conflict rules for playlist order
- [ ] Never upload imported audio unless user opts into cloud storage

## Realtime collaboration

- [ ] Invite by link/email; accept/decline; remove member; change role (owner only)
- [ ] Live updates to playlist tracks and membership
- [ ] Collaborators screen replaces sample members with real ones; "Viewing as" kept only as a preview for owners
- [ ] Presence and edit conflicts handled (reorder, concurrent add/remove)

## Cloud storage

- [ ] Optional per-user uploads of owned files, size quotas, signed URLs
- [ ] Users attest they have rights; takedown/reporting process

## Downloader server: what v2 adds

v1 ships `apps/server` (Fastify + yt-dlp, Docker): single user, one shared bearer token. It only searches and returns direct stream links (no downloads, tags or file serving); the device downloads saved songs. It runs only on a server since yt-dlp needs a native process. v2 work:

- [ ] Accounts and auth: replace `OPEN_RECORD_TOKEN` with per-user credentials (tokens or sessions), revocable
- [ ] Multi-user: per-user quotas and resolve limits; no cross-user cache sharing
- [ ] Secure token storage in the app (Keychain / Keystore plugin) instead of plain text in the settings collection
- [ ] Optional server-side proxy so links work off the home network (reintroduces bandwidth load; needs quotas)
- [ ] Rate and abuse controls: per-user limits, concurrency quotas, audit log
- [ ] Hardening against DNS rebinding: the URL guard checks the resolved address, but yt-dlp resolves again and follows redirects; pin resolved IPs or run yt-dlp in an egress-restricted network namespace/container
- [ ] Optional plain-HTTP LAN support decision (Android cleartext / iOS ATS), otherwise keep HTTPS-only

**Honest risk statement**
- Downloading from YouTube violates YouTube's Terms of Service, and downloading copyrighted music without permission raises copyright issues. Other services have similar terms.
- The README disclaimer applies: the author is not responsible for music users download and users are responsible for their rights. See [README](../README.md).
- App stores may reject apps that bundle or promote such downloaders.

**Mitigations / rules**
- [x] Separate service (`apps/server`) and provider (`libs/providers/remote`); server imports only models
- [ ] Off by default (done: needs URL + token); excluded from store builds (open)
- [x] Self-hosted: user runs their own service and enters its URL; the project hosts none
- [ ] Explicit rights acknowledgement in the app before first use, linking the disclaimer (server README has one)
- [ ] Per-user rate limits, no public redistribution, no sharing downloaded audio via collaborative playlists (share metadata only)
- [ ] Prefer legal sources where available (public-domain, CC-licensed, user's own files)
- [ ] Legal review before any distribution

## Milestones

- [ ] M1 Spike: pick backend, schema, auth
- [ ] M2 Auth + sync
- [ ] M3 Realtime collaboration + Collaborators screen live
- [ ] M4 Cloud storage (optional)
- [ ] M5 Downloader hardening and multi-user (server exists since v1 M3.5), after legal review
- [ ] M6 Privacy docs, security tests, store updates

## Risks

- Legal/ToS exposure from downloaders (isolation, flags, self-hosting)
- Sync conflicts and data loss (offline queue, tests)
- Hosting cost and abuse (quotas, rate limits)
- Store policy and privacy compliance
