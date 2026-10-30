import { stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import type { SessionTrack } from '@open-record/models';
import { validateUrl } from './url-guard';

/**
 * What the server can do with one queue entry. `not-resolved` is reserved for
 * load-time resolution failures; `planFor` never returns it.
 */
export type MediaPlan =
  | { kind: 'remote'; pageUrl: string }
  | { kind: 'catalog'; file: string }
  | { kind: 'upload'; uploadId: string }
  | { kind: 'unavailable'; reason: 'no-source' | 'local-on-device' | 'not-resolved' };

/** A catalog audio file must be a plain basename with a supported extension. */
const CATALOG_FILE_RE = /^[\w.-]+\.(mp3|m4a|aac|ogg|opus|flac|wav)$/;

/** Directory holding catalog audio served by the web app. */
function catalogAudioDir(webDir: string): string {
  return resolve(webDir, 'catalog', 'audio');
}

/**
 * Absolute path of `file` under `<webDir>/catalog/audio`. Callers must have
 * validated `file` as a plain basename (see {@link planFor}).
 */
export function catalogAudioPath(webDir: string, file: string): string {
  return resolve(catalogAudioDir(webDir), file);
}

/** True when `file` is a safe catalog basename (no separators, known extension). */
function isCatalogFile(file: string): boolean {
  return file === basename(file) && CATALOG_FILE_RE.test(file);
}

/** True when `path` is inside `root` (lexical containment; `file` has no separators). */
function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function catalogPlan(file: string, webDir: string | null | undefined): Promise<MediaPlan> {
  if (!isCatalogFile(file)) return { kind: 'unavailable', reason: 'no-source' };
  if (webDir) {
    const root = catalogAudioDir(webDir);
    const path = catalogAudioPath(webDir, file);
    if (!isInside(root, path)) return { kind: 'unavailable', reason: 'no-source' };
    try {
      const info = await stat(path);
      if (!info.isFile()) return { kind: 'unavailable', reason: 'no-source' };
    } catch {
      return { kind: 'unavailable', reason: 'no-source' };
    }
  }
  return { kind: 'catalog', file };
}

/**
 * Decides how the server can serve a queue entry, in precedence order:
 * upload → local → catalog → remote → unavailable.
 *
 * A remote `source.url` is validated here first; anything the SSRF guard
 * rejects becomes `unavailable/no-source`, never a plan.
 */
export async function planFor(
  track: SessionTrack,
  opts: { webDir?: string | null } = {},
): Promise<MediaPlan> {
  const uploadId = track.uploadId?.trim();
  if (uploadId) return { kind: 'upload', uploadId };

  if (track.local) return { kind: 'unavailable', reason: 'local-on-device' };

  const catalogFile = track.catalogFile?.trim();
  if (catalogFile) return catalogPlan(catalogFile, opts.webDir);

  const pageUrl = track.source?.url;
  if (pageUrl !== undefined) {
    try {
      const { url } = await validateUrl(pageUrl);
      return { kind: 'remote', pageUrl: url };
    } catch {
      return { kind: 'unavailable', reason: 'no-source' };
    }
  }

  return { kind: 'unavailable', reason: 'no-source' };
}
