# v2: Backend

Everything that needs a server: accounts, sync, realtime collaboration, optional downloader providers. Builds on v1 interfaces (`MusicSourceProvider`, storage port, role logic).

## Goals

- [ ] Accounts and sign-in
- [ ] Sync library/playlists across devices (offline-first, v1 local store stays source of truth on device)
- [ ] Realtime collaborative playlists; Collaborators screen goes live
- [ ] Optional, isolated downloader-service providers
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
| Custom jobs (downloader service) | Edge functions / separate service | Cloud Functions | Native fit |

**Recommendation:** Supabase for auth, Postgres (RLS enforces Owner/Editor/Viewer), realtime and storage. Add a small separate NestJS service in the Nx repo only for the downloader service and anything needing long-running jobs. Reason: relational playlist/membership data fits Postgres, roles map cleanly to RLS, and open source keeps self-hosting possible. Confirm with a short spike before committing.

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

## Downloader-service providers (optional, isolated)

Implement `MusicSourceProvider` with `download`, running only on a server since yt-dlp-style tools need a native process and cannot run in a pure client app.

**Honest risk statement**
- Downloading from YouTube violates YouTube's Terms of Service, and downloading copyrighted music without permission raises copyright issues. Other services have similar terms.
- The README disclaimer applies: the author is not responsible for music users download and users are responsible for their rights. See [README](../README.md).
- App stores may reject apps that bundle or promote such downloaders.

**Mitigations / rules**
- [ ] Separate package/service (`libs/providers/*` + `apps/downloader-service`), not imported by default builds
- [ ] Feature-flagged and off by default; excluded from store builds
- [ ] User-supplied or self-hosted: user runs their own service and enters its URL; the project hosts none
- [ ] Explicit rights acknowledgement before first use, linking the disclaimer
- [ ] Rate limits, no public redistribution, no sharing downloaded audio via collaborative playlists (share metadata only)
- [ ] Prefer legal sources where available (public-domain, CC-licensed, user's own files)
- [ ] Legal review before any distribution

## Milestones

- [ ] M1 Spike: pick backend, schema, auth
- [ ] M2 Auth + sync
- [ ] M3 Realtime collaboration + Collaborators screen live
- [ ] M4 Cloud storage (optional)
- [ ] M5 Downloader service (self-hosted, flagged), after legal review
- [ ] M6 Privacy docs, security tests, store updates

## Risks

- Legal/ToS exposure from downloaders (isolation, flags, self-hosting)
- Sync conflicts and data loss (offline queue, tests)
- Hosting cost and abuse (quotas, rate limits)
- Store policy and privacy compliance
