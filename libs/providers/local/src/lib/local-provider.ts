import type { PlayableSource, Track } from '@open-record/models';
import { createDefaultFileStore, IMPORT_DIR, type LocalFileStore, type PickedAudio } from './file-store';
import {
  audioExtension,
  imageExtension,
  LOCAL_PROVIDER_ID,
  localKeyFromTrackId,
  mimeFromName,
  toLocalTrack,
  type LocalTagInfo,
} from './local-tracks';
import { pickAudioFiles } from './pick-audio';

export interface ImportFailure {
  fileName: string;
  error: unknown;
}

export interface ImportResult {
  /** New tracks, ready to be persisted by the caller (library/state layer). */
  tracks: Track[];
  failures: ImportFailure[];
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')).join('-');
}

const keyPrefix = (key: string) => `${IMPORT_DIR}/${key}.`;
const audioPrefix = (key: string) => `${IMPORT_DIR}/${key}.audio.`;

/** Key of a stored file path (`imported/<key>.audio.mp3` -> `<key>`). */
function keyOfPath(path: string): string | null {
  const name = path.startsWith(`${IMPORT_DIR}/`) ? path.slice(IMPORT_DIR.length + 1) : null;
  return name?.split('.')[0] || null;
}

/**
 * User-imported audio files. Satisfies MusicSourceProvider from
 * @open-record/music-source structurally (providers may only import
 * @open-record/models).
 *
 * The provider owns the stored bytes (audio + cover art) but not the track
 * records: `importFiles` returns Track objects for the state/storage layer to
 * persist, and `search` returns nothing (local tracks are searched from the
 * persisted library).
 */
export class LocalProvider {
  readonly id = LOCAL_PROVIDER_ID;
  readonly capabilities = { search: false, download: false } as const;

  constructor(private readonly store: LocalFileStore = createDefaultFileStore()) {}

  async search(_query: string): Promise<Track[]> {
    return [];
  }

  async resolve(trackId: string): Promise<PlayableSource> {
    const key = localKeyFromTrackId(trackId);
    const entry = key ? (await this.store.list()).find((f) => f.path.startsWith(audioPrefix(key))) : undefined;
    if (!entry) throw new Error(`Imported file for "${trackId}" not found`);
    return { url: await this.store.url(entry.path), kind: 'file', mimeType: mimeFromName(entry.path) };
  }

  /** Loadable URL for a local track's stored cover, if it has one. Not stable across launches: do not persist. */
  async artUrl(track: Pick<Track, 'coverPath'>): Promise<string | undefined> {
    if (!track.coverPath) return undefined;
    return this.store.url(track.coverPath).catch(() => undefined);
  }

  /** Open the system picker and import the chosen files. Empty result if dismissed. */
  async pickAndImport(): Promise<ImportResult> {
    return this.importFiles(await pickAudioFiles());
  }

  /** Copy files into app storage and read their tags/cover art. */
  async importFiles(files: PickedAudio[]): Promise<ImportResult> {
    const result: ImportResult = { tracks: [], failures: [] };
    for (const file of files) {
      try {
        result.tracks.push(await this.importOne(file));
      } catch (error) {
        result.failures.push({ fileName: file.name, error });
      }
    }
    return result;
  }

  /** Delete a track's stored audio and cover. Resolves to the bytes freed. */
  async remove(trackOrId: string | Pick<Track, 'id'>): Promise<number> {
    const key = localKeyFromTrackId(typeof trackOrId === 'string' ? trackOrId : trackOrId.id);
    if (!key) return 0;
    return this.removeWhere((path) => path.startsWith(keyPrefix(key)));
  }

  /** Delete stored files that belong to none of `keepTrackIds` (orphans). Resolves to the bytes freed. */
  async cleanup(keepTrackIds: Iterable<string>): Promise<number> {
    const keep = new Set<string>();
    for (const id of keepTrackIds) {
      const key = localKeyFromTrackId(id);
      if (key) keep.add(key);
    }
    return this.removeWhere((path) => !keep.has(keyOfPath(path) ?? ''));
  }

  /** Total bytes used by imported audio and covers. */
  async bytesUsed(): Promise<number> {
    return (await this.store.list()).reduce((sum, f) => sum + f.sizeBytes, 0);
  }

  /** Bytes used, split into audio files and cover art (embedded or fetched). */
  async usage(): Promise<{ audioBytes: number; artBytes: number }> {
    let audioBytes = 0;
    let artBytes = 0;
    for (const f of await this.store.list()) {
      if (f.path.includes('.audio.')) audioBytes += f.sizeBytes;
      else artBytes += f.sizeBytes;
    }
    return { audioBytes, artBytes };
  }

  /**
   * Store cover art fetched online (e.g. Cover Art Archive) next to a local
   * track's audio so it works offline. Resolves to the new `coverPath`, or
   * undefined for a non-local id or a failed write. Removed with the track.
   */
  async storeCover(trackId: string, data: Uint8Array, mimeType: string): Promise<string | undefined> {
    const key = localKeyFromTrackId(trackId);
    if (!key) return undefined;
    const mime = mimeType.includes('/') ? mimeType : 'image/jpeg';
    const path = `${keyPrefix(key)}cover-online.${imageExtension(mime)}`;
    try {
      await this.store.write(path, data, mime);
      return path;
    } catch {
      return undefined;
    }
  }

  private async removeWhere(match: (path: string) => boolean): Promise<number> {
    let freed = 0;
    for (const entry of await this.store.list()) {
      if (!match(entry.path)) continue;
      await this.store.remove(entry.path);
      freed += entry.sizeBytes;
    }
    return freed;
  }

  private async importOne(file: PickedAudio): Promise<Track> {
    const key = newKey();
    const sourceFile = `${audioPrefix(key)}${audioExtension(file.name, file.mimeType)}`;
    try {
      const sizeBytes = await this.store.copyIn(sourceFile, file);
      const tags = await this.readTags(file, sourceFile, sizeBytes);
      const coverPath = tags?.cover ? await this.saveCover(key, tags.cover) : undefined;
      return toLocalTrack({ key, fileName: file.name, sourceFile, sizeBytes, coverPath }, tags?.info);
    } catch (err) {
      await this.removeWhere((path) => path.startsWith(keyPrefix(key))).catch(() => undefined);
      throw err;
    }
  }

  private async saveCover(key: string, cover: { format: string; data: Uint8Array }): Promise<string | undefined> {
    const mime = cover.format.includes('/') ? cover.format : `image/${cover.format || 'jpeg'}`;
    const path = `${keyPrefix(key)}cover.${imageExtension(mime)}`;
    try {
      await this.store.write(path, cover.data, mime);
      return path;
    } catch {
      return undefined; // art is optional; the UI shows the disc fallback
    }
  }

  /** Tags + embedded cover; `null` when unreadable (the file name is used instead). */
  private async readTags(
    file: PickedAudio,
    storedPath: string,
    size: number,
  ): Promise<{ info: LocalTagInfo; cover?: { format: string; data: Uint8Array } } | null> {
    try {
      const mm = await import('music-metadata');
      const options = { duration: false, skipCovers: false };
      let meta;
      if (file.blob) {
        meta = await mm.parseBlob(file.blob, options);
      } else {
        const res = await fetch(await this.store.url(storedPath));
        if (!res.ok || !res.body) return null;
        meta = await mm.parseWebStream(res.body, { mimeType: file.mimeType, size }, options);
      }
      const cover = mm.selectCover(meta.common.picture) ?? undefined;
      return { info: meta, cover: cover ? { format: cover.format, data: cover.data } : undefined };
    } catch {
      return null;
    }
  }
}
