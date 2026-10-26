# feature-import

`@open-record/features/import` exports `ImportPage`, the routed `/import` screen: the
Spotify import wizard (Exportify CSV pasted or picked, linking to exportify.app, or data-download JSON),
playlist selection, matching progress, review, unmatched CSV export and deleting import data.
Imported playlists sync between devices when signed in (Settings > Sync now).
Screens may import only `@open-record/state`, `@open-record/ui` and `@open-record/models`.

Sign-in (Supabase email/password) is required to import; the Import wizard is gated behind an account.
