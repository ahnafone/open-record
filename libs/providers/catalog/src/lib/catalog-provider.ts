import type { PlayableSource, Track } from '@open-record/models';
import {
  CATALOG_ASSET_BASE,
  CATALOG_ENTRIES,
  CATALOG_PROVIDER_ID,
  type CatalogEntry,
} from './catalog-tracks';

function toTrack(entry: CatalogEntry): Track {
  const { audioFile, ...meta } = entry;
  return { ...meta, tags: entry.tags && [...entry.tags], catalogFile: audioFile };
}

/**
 * Bundled public-domain / openly licensed catalogue. Satisfies the
 * MusicSourceProvider contract from @open-record/music-source structurally
 * (providers may only import @open-record/models). Makes no network calls:
 * audio and art ship with the app under `catalog/`.
 */
export class CatalogProvider {
  readonly id = CATALOG_PROVIDER_ID;
  readonly capabilities = { search: true, download: false } as const;

  /** All catalogue tracks, in catalogue order. */
  async list(): Promise<Track[]> {
    return CATALOG_ENTRIES.map(toTrack);
  }

  /** Case-insensitive match on title, artist, year or genre; blank query returns everything. */
  async search(query: string): Promise<Track[]> {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return CATALOG_ENTRIES.filter((e) =>
      [e.title, e.artist, e.year?.toString(), e.genre].some((f) => f?.toLowerCase().includes(q)),
    ).map(toTrack);
  }

  async resolve(trackId: string): Promise<PlayableSource> {
    const entry = CATALOG_ENTRIES.find((e) => e.id === trackId);
    if (!entry) throw new Error(`Unknown catalog track "${trackId}"`);
    return {
      url: `${CATALOG_ASSET_BASE}/audio/${entry.audioFile}`,
      kind: 'bundled',
      mimeType: 'audio/mpeg',
    };
  }
}
