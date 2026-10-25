export interface MetadataAttribution {
  name: string;
  url: string;
  license: string;
  text: string;
}

export const MUSICBRAINZ_ATTRIBUTION: MetadataAttribution = {
  name: 'MusicBrainz',
  url: 'https://musicbrainz.org',
  license: 'CC0 1.0 (core data)',
  text: 'Track metadata from MusicBrainz (core data released under CC0).',
};

export const COVER_ART_ARCHIVE_ATTRIBUTION: MetadataAttribution = {
  name: 'Cover Art Archive',
  url: 'https://coverartarchive.org',
  license: 'Copyright of the respective rights holders',
  text: 'Cover art from the Cover Art Archive, a joint project of MusicBrainz and the Internet Archive.',
};

export const METADATA_ATTRIBUTIONS: readonly MetadataAttribution[] = [
  MUSICBRAINZ_ATTRIBUTION,
  COVER_ART_ARCHIVE_ATTRIBUTION,
];
