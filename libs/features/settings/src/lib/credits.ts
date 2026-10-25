/**
 * Credits for the online metadata sources. Mirrors `METADATA_ATTRIBUTIONS`
 * in @open-record/metadata, which feature libs may not import.
 */
export interface MetadataCredit {
  name: string;
  url: string;
  license: string;
  text: string;
}

export const METADATA_CREDITS: readonly MetadataCredit[] = [
  {
    name: 'MusicBrainz',
    url: 'https://musicbrainz.org',
    license: 'CC0 1.0 (core data)',
    text: 'Track metadata from MusicBrainz (core data released under CC0).',
  },
  {
    name: 'Cover Art Archive',
    url: 'https://coverartarchive.org',
    license: 'Copyright of the respective rights holders',
    text: 'Cover art from the Cover Art Archive, a joint project of MusicBrainz and the Internet Archive.',
  },
];

/** Music disclaimer, as in the project README. */
export const MUSIC_DISCLAIMER =
  'The author is not responsible for any music that users choose to import, and owns no copyrights to any songs imported. Users are solely responsible for ensuring they have the rights to any music they import or use.';
