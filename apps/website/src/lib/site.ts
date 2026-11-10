// Shared site facts. Every link and asset path on the site goes through url() or absolute(),
// so the GitHub Pages project base (/open-record/) is applied in one place.

export const VERSION = 'v0.0.4';
export const BADGE_TEXT = `Beta · ${VERSION}`;

export const REPO = 'https://github.com/ahnafone/open-record';
export const WEB_APP_URL = 'https://open-record.uttarasoftware.ca';
export const IPHONE_GUIDE_URL = `${REPO}/blob/main/docs/ios-install.md`;
export const DESKTOP_GUIDE_URL = `${REPO}/blob/main/docs/desktop.md`;
export const SERVER_GUIDE_URL = `${REPO}/blob/main/apps/server/README.md`;
export const LICENSE_URL = `${REPO}/blob/main/LICENSE`;
export const README_URL = `${REPO}/blob/main/README.md`;
export const RELEASES_URL = `${REPO}/releases/latest`;
export const INSTALL_GUIDE_URL = `${REPO}#install-and-run`;
export const ATTRIBUTION_URL = `${REPO}/blob/main/mockup/ATTRIBUTION.md`;

const RELEASE_DOWNLOAD = `${REPO}/releases/latest/download`;

export const DOWNLOADS = {
  linuxDeb: `${RELEASE_DOWNLOAD}/OpenRecord-linux-amd64.deb`,
  linuxAppImage: `${RELEASE_DOWNLOAD}/OpenRecord-linux-x86_64.AppImage`,
  windows: `${RELEASE_DOWNLOAD}/OpenRecord-windows-x64.exe`,
  android: `${RELEASE_DOWNLOAD}/OpenRecord-android.apk`,
} as const;

/** Site base path, e.g. "/open-record/". Always ends with a slash. */
const BASE = import.meta.env.BASE_URL;

/** Root-relative URL for a site path, base-aware. url('install/') -> '/open-record/install/'. */
export function url(path = ''): string {
  return BASE + path.replace(/^\/+/, '');
}

/** Absolute URL on the public origin, base-aware. Used for canonical and og:image. */
export function absolute(path = ''): string {
  return new URL(url(path), import.meta.env.SITE).href;
}
