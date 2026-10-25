import type { Track } from '@open-record/models';

export const CATALOG_PROVIDER_ID = 'catalog';

/** Base path of the bundled files (apps/app/public/catalog), relative to the app base href. */
export const CATALOG_ASSET_BASE = 'catalog';

export interface CatalogEntry extends Track {
  /** File name under `${CATALOG_ASSET_BASE}/audio/`. */
  audioFile: string;
}

/**
 * The bundled sample catalogue: five openly licensed Wikimedia Commons items.
 * Metadata, licences and credits follow mockup/index.html and
 * mockup/ATTRIBUTION.md.
 */
export const CATALOG_ENTRIES: readonly CatalogEntry[] = [
  {
    id: 'catalog:sandman',
    providerId: CATALOG_PROVIDER_ID,
    title: 'The Japanese Sandman',
    artist: 'Paul Whiteman & His Ambassador Orchestra',
    year: 1920,
    genre: 'Dance band',
    durationSec: 180,
    artUrl: `${CATALOG_ASSET_BASE}/art/sandman.jpg`,
    tags: ['78 rpm shellac', 'Victor'],
    license: 'Public domain',
    credit: 'Performed 1920 by Paul Whiteman & His Ambassador Orchestra',
    audioFile: 'japanese-sandman.mp3',
  },
  {
    id: 'catalog:afghanistan',
    providerId: CATALOG_PROVIDER_ID,
    title: 'Afghanistan (Fox Trot)',
    artist: "Prince's Dance Orchestra",
    year: 1920,
    genre: 'Fox trot',
    durationSec: 196,
    artUrl: `${CATALOG_ASSET_BASE}/art/prince.jpg`,
    tags: ['78 rpm shellac', 'Columbia'],
    license: 'Public domain',
    credit: "Recorded 1920 for Columbia by Prince's Dance Orchestra",
    audioFile: 'afghanistan.mp3',
  },
  {
    id: 'catalog:harlem',
    providerId: CATALOG_PROVIDER_ID,
    title: 'Harlem Rag (Two Step)',
    artist: 'Tom Turpin',
    year: 1897,
    genre: 'Ragtime',
    durationSec: 172,
    artUrl: `${CATALOG_ASSET_BASE}/art/harlem-rag.jpg`,
    tags: ['Ragtime piano two-step', 'Jos. W. Stern & Co.'],
    license: 'CC BY-SA 3.0',
    credit:
      'Composed 1897 by Tom Turpin · recording performed by Gnissah (Wikimedia Commons), 2026, licensed CC BY-SA 3.0',
    audioFile: 'harlem-rag.mp3',
  },
  {
    id: 'catalog:sousa',
    providerId: CATALOG_PROVIDER_ID,
    title: "Columbia's Pride (March)",
    artist: 'John Philip Sousa',
    year: 1914,
    genre: 'March',
    durationSec: 68,
    artUrl: `${CATALOG_ASSET_BASE}/art/sousa.jpg`,
    tags: ['Concert march', 'U.S. Marine Band'],
    license: 'Public domain',
    credit:
      'Composed 1914 by John Philip Sousa · performed by the U.S. Marine Band, Col. Jason K. Fettig',
    audioFile: 'sousa-columbias-pride.mp3',
  },
  {
    id: 'catalog:bach',
    providerId: CATALOG_PROVIDER_ID,
    title: 'Goldberg Variations — Aria',
    artist: 'J. S. Bach',
    year: 1741,
    genre: 'Baroque',
    durationSec: 287,
    artUrl: `${CATALOG_ASSET_BASE}/art/bach.jpg`,
    tags: ['Keyboard aria', 'Musopen'],
    license: 'CC0 1.0',
    credit: 'Composed 1741 by J. S. Bach · Musopen public-domain recording',
    audioFile: 'bach-goldberg-aria.mp3',
  },
];
