# Install Open Record on iPhone (build from source)

> **Status: not tested yet.** These steps come from the project's Xcode setup and have not been
> verified on a physical iPhone. If something differs on your Mac or device, please report it.

There is no App Store, TestFlight or prebuilt iPhone download. You build the app yourself in Xcode and
install it on your own iPhone with a **free Apple ID**. The install is limited:

- It expires after **7 days**. Re-run it from Xcode to re-sign and reinstall.
- Deleting the app deletes its downloads and library data.
- Each person uses their own Apple ID. Do not share a signed build.

## What you need

- A **Mac** with a recent **Xcode** installed from the Mac App Store, opened at least once so its
  command-line tools and iOS SDK are installed.
- **Node 24** and npm.
- An **iPhone** on iOS 18 or later, and a USB cable.
- A **free Apple ID** (a personal account is enough; no paid developer program).

## 1. Get the code and install dependencies

```bash
git clone https://github.com/ahnafone/open-record.git
cd open-record
npm ci
```

## 2. Open the project in Xcode

```bash
npm run ios:open
```

This builds the web app, copies it into the iOS project with Capacitor, and opens
`apps/app/ios/App/App.xcodeproj` in Xcode. (`npm run ios` does the same sync and then runs the app
through the Capacitor CLI. For a device, use Xcode as described here.)

## 3. Add your Apple ID and pick a team

1. In Xcode, go to **Xcode > Settings > Accounts**, click **+**, and sign in with your Apple ID.
2. In the project navigator, select the **App** project, then the **App** target.
3. Open **Signing & Capabilities**.
4. Tick **Automatically manage signing**.
5. Under **Team**, choose **your name (Personal Team)**.

The project does not contain a team ID, so each person picks their own.

If Xcode says the bundle ID `app.openrecord` is already registered to someone else, change it to a
unique value such as `app.openrecord.<yourname>` in the same panel, then select your team again.

## 4. Use the Release configuration

The Release build is what you want on the phone.

1. Go to **Product > Scheme > Edit Scheme...**.
2. Select **Run** in the left list.
3. Set **Build Configuration** to **Release**, then click **Close**.

## 5. Connect and run

1. Plug in the iPhone and unlock it. Tap **Trust** on the phone if asked, and enter the passcode.
2. On the phone, enable **Settings > Privacy & Security > Developer Mode** and restart it when prompted.
   (This option only appears after the phone has been connected to Xcode once.)
3. In Xcode's toolbar, choose your iPhone as the run destination.
4. Press **Run** (the play button, or **Product > Run**).

The first build can take several minutes. Xcode installs the app on the phone when it finishes.

## 6. Trust the developer on the phone

The first time you open Open Record, iOS blocks it until you trust your developer profile:

1. Open **Settings > General > VPN & Device Management**.
2. Under **Developer App**, tap your Apple ID.
3. Tap **Trust**, then confirm.

Open Record can then be launched from the home screen.

## Renewing after 7 days

When the app stops opening, connect the phone, and press **Run** in Xcode again with the same Apple ID
and the same bundle ID. Keep the same bundle ID and team so the reinstall keeps your data. (If the
bundle ID changes, the app is treated as a new app and existing data is not carried over.)

## Troubleshooting

- **"Failed to register bundle identifier" / bundle ID taken:** use a unique bundle ID as in step 3.
- **Phone not listed as a destination:** unlock the phone, reconnect the cable, and check that Developer
  Mode is on.
- **"Untrusted Developer" or the app will not open:** finish step 6.
- **Signing errors after changing accounts:** in **Signing & Capabilities**, untick and re-tick
  **Automatically manage signing**, then choose the team again.
- **`npm run ios:release` produces a build you cannot install:** that target builds a generic Release
  archive. Use Xcode Run on a device, as above.

## Not covered here

- Android install: see the [README](../README.md#android).
- Desktop app: see [desktop.md](desktop.md).
- Signing with a paid Apple Developer account, TestFlight or the App Store are not set up.
