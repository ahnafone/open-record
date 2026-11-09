# iOS release signing (Mac)

The project intentionally has no `DEVELOPMENT_TEAM`: the release is installed
with a free Apple ID, and each person must select their own Personal Team.
`MARKETING_VERSION` is `0.0.2`, `CURRENT_PROJECT_VERSION` is `2`, and the bundle
ID is `app.openrecord`.

## Select the team in Xcode

1. Open `apps/app/ios/App/App.xcodeproj` (the `App` scheme is shared).
2. Select the **App** target -> **Signing & Capabilities**.
3. Enable **Automatically manage signing** and choose your **Personal Team**
   (add your Apple ID under Xcode -> Settings -> Accounts first).
4. If Apple says `app.openrecord` is already registered, change the bundle ID
   to a unique fallback such as `app.openrecord.<yourname>` and select the team
   again. Do not commit a personal team ID.

## Install on a device

1. Connect the iPhone, enable **Developer Mode** (Settings -> Privacy &
   Security -> Developer Mode), and trust the computer.
2. Select the iPhone as the run destination and use **Product -> Run** with the
   **Release** configuration (Scheme -> Edit Scheme -> Run -> Build
   Configuration -> Release).
3. On first launch, trust the developer certificate under Settings -> General ->
   VPN & Device Management.

Do not use the generic `ios:release` target: it produces an uninstallable
archive on Linux/CI. A free Apple ID build expires after **7 days** and must be
re-signed by running from Xcode again. TestFlight/App Store distribution is not
used for 0.0.2.
