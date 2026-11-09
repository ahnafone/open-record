# feature-about

`@open-record/features/about` exports `AboutPage`, the routed `/about` screen: app name and
version, how it works (public server or self-host), project links and the music disclaimer.
Visible to everyone on every platform. `APP_VERSION` is read from the root `package.json`.
Screens may import only `@open-record/state`, `@open-record/ui` and `@open-record/models`.
