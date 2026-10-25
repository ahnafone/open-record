# Roadmap

Planning docs for Open Record. Status: design stage, no app code yet.

| Phase | Scope | Status | Doc |
|---|---|---|---|
| v1 | Frontend-only app (Angular + Capacitor, Android/iOS/web). Local files + bundled public-domain catalog. No backend. | Planned | [v1-frontend.md](v1-frontend.md) |
| v2 | Backend: auth, sync, realtime collaborative playlists, optional downloader providers. | Planned | [v2-backend.md](v2-backend.md) |
| v3+ | Ideas only. | Unscheduled | [v3-and-beyond.md](v3-and-beyond.md) |

## Principles

- **Design fidelity:** UI follows [DESIGN.md](../DESIGN.md) and the [mockup](../mockup/index.html). Tokens become CSS variables; no ad-hoc styling.
- **AI-agent workflow:** work follows [AGENTS.md](../AGENTS.md). Parallelizable tasks go to sub-agents. After every feature run Nx lint, type check and build.
- **Small permanent test suite:** only core security and major-functionality regressions (e.g. playback queue, persistence, role permissions in v2). No exhaustive coverage goal.
- **Rights:** the app ships only public-domain/openly licensed media. The README music disclaimer applies to everything users add.
- **Decisions fixed:** Angular + Capacitor + Nx (no Expo). v1 has no backend.
