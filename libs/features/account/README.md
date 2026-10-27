# feature-account

`@open-record/features/account` exports `AccountPage`, the routed `/account` screen
(sign-in form when signed out; profile, stats, sync, change password (current one required) and email, sign out
everywhere and delete account when signed in), plus `AccountSection` and the app-shell
`OrSignInPrompt` modal that reuses its form.
Screens may import only `@open-record/state`, `@open-record/ui` and `@open-record/models`.
