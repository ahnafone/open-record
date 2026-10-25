import { parseFileName, toLocalTrack } from './local-tracks';

const file = { key: 'abc-123', fileName: '03 - Nina Simone - Feeling Good.mp3', sourceFile: 'imported/abc-123.audio.mp3', sizeBytes: 42 };

describe('local track mapping', () => {
  it('falls back to the file name when there are no tags', () => {
    expect(parseFileName('track_07.flac')).toEqual({ title: 'track 07' });
    expect(toLocalTrack(file)).toMatchObject({
      id: 'local:abc-123',
      providerId: 'local',
      title: 'Feeling Good',
      artist: 'Nina Simone',
      sourceFile: 'imported/abc-123.audio.mp3',
      sizeBytes: 42,
    });
  });

  it('prefers tags and maps album, year, genre, duration and mbids', () => {
    const track = toLocalTrack(file, {
      common: { title: ' Sinnerman ', artists: ['Nina Simone'], album: 'Pastel Blues', year: 1965, genre: ['Jazz'], musicbrainz_recordingid: 'rec-1' },
      format: { duration: 622.4 },
    });
    expect(track).toMatchObject({ title: 'Sinnerman', artist: 'Nina Simone', album: 'Pastel Blues', year: 1965, genre: 'Jazz', durationSec: 622, mbids: { recording: 'rec-1' } });
  });
});
