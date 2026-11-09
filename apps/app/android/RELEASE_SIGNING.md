# Android release signing

Open Record release builds (`assembleRelease`, `bundleRelease`) require a real
keystore. If `keystore.properties` or the keystore is missing, Gradle stops with
a clear error instead of shipping a debug-signed APK. `./gradlew tasks` and
other config-only invocations still work without a keystore.

## 1. Create the keystore outside the repository

```bash
mkdir -p ~/keystores
keytool -genkeypair -v \
  -keystore ~/keystores/open-record-release.jks \
  -alias openrecord \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype JKS
```

`keytool` is part of the JDK. Use strong passwords, store them in a password
manager, and back up the keystore. Losing it means existing installs can never
be updated; the app would have to be uninstalled and reinstalled.

## 2. Create `keystore.properties` (gitignored)

Create `apps/app/android/keystore.properties`:

```properties
storeFile=/home/<you>/keystores/open-record-release.jks
storePassword=...
keyAlias=openrecord
keyPassword=...
```

`storeFile` must be an absolute path outside this repository (a relative path is
resolved from `apps/app/android/`). This file is ignored by git; never commit it.

## 3. Build and verify

```bash
cd apps/app/android
./gradlew assembleRelease

# Replace 36.0.0 with your installed build-tools version.
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

The output APK is `app/build/outputs/apk/release/app-release.apk` and should
report `versionCode 2`, `versionName 0.0.2` (`aapt dump badging ...`).

## Local performance builds only

To build an optimized release variant without a keystore, opt in explicitly:

```bash
./gradlew assembleRelease -PallowDebugSigning
```

This signs with the debug key for local testing only; do not distribute it. If a
valid release keystore is configured, the real release signing is used even when
the flag is present.

## Install note

A release-signed APK cannot be installed over a debug-signed build
(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). Uninstalling the old app removes its
data, including downloaded songs, and `allowBackup` is off so Android cannot
restore it.

To keep user data, always update in place with `adb install -r` (what
`npm run android:release:install` does) and sign every install on a device with
the same key. Never ask users to uninstall to get past a signature mismatch
unless they accept losing their downloads.
