import { AUTO_ACCEPT_SCORE, REVIEW_SCORE, matchTrack } from './match';
import { mapSpotifyApiTracks, parseDataDownloadJson, parseImportFile } from './parsers';
import type { ImportedTrack } from './types';

const ID_A = '4uLU6hMCjMI75M1A2tKUQC';
const ID_B = '7ouMYWpwJ422jRcDASZB7P';

describe('spotify import parsing', () => {
  it('parses Exportify CSV with quotes, embedded newlines, CRLF and duplicates', () => {
    const csv =
      '﻿Track URI,Track Name,Artist Name(s),Album Name,Duration (ms),ISRC,Added At\r\n' +
      `spotify:track:${ID_A},"Hello, ""World""",A;B,Alb,200000,usum71234567,2024-01-01T00:00:00Z\r\n` +
      `spotify:track:${ID_B},"Two\nLines",Solo,,abc,,\r\n` +
      `spotify:track:${ID_A},"Hello, ""World""",A;B,Alb,200000,USUM71234567,\r\n` +
      ',,,,,,\r\n';
    const parsed = parseImportFile('Road_Trip.csv', csv);
    expect(parsed.liked).toEqual([]);
    const [pl] = parsed.playlists;
    expect(pl.name).toBe('Road Trip');
    expect(pl.tracks).toHaveLength(2);
    expect(pl.tracks[0]).toMatchObject({
      title: 'Hello, "World"',
      artists: ['A', 'B'],
      album: 'Alb',
      durationMs: 200000,
      isrc: 'USUM71234567',
      spotifyId: ID_A,
    });
    expect(pl.tracks[1]).toMatchObject({ title: 'Two\nLines', artists: ['Solo'], spotifyId: ID_B });
    expect(pl.tracks[1].durationMs).toBeUndefined();
    expect(parseImportFile('Liked_Songs.csv', csv).liked).toHaveLength(2);
    expect(() => parseImportFile('x.csv', 'foo,bar\n1,2')).toThrow(/Exportify/);
    expect(() => parseImportFile('my_spotify_data.zip', '')).toThrow(/Unzip/);
  });

  it('parses data-download JSON and Web API items, skipping episodes and nulls', () => {
    const json = JSON.stringify({
      playlists: [
        {
          name: 'Chill',
          items: [
            { track: { trackName: 'Song', artistName: 'Art', albumName: 'Al', trackUri: `spotify:track:${ID_A}` } },
            { track: null, episode: { episodeName: 'Pod' } },
          ],
        },
      ],
    });
    expect(parseDataDownloadJson(json).playlists).toEqual([
      { name: 'Chill', tracks: [{ title: 'Song', artists: ['Art'], artist: 'Art', album: 'Al', spotifyId: ID_A }] },
    ]);
    const library = parseDataDownloadJson(JSON.stringify({ tracks: [{ artist: 'X', album: 'Y', track: 'Z', uri: `spotify:track:${ID_B}` }] }));
    expect(library.liked[0]).toMatchObject({ title: 'Z', artist: 'X', spotifyId: ID_B });
    expect(() => parseDataDownloadJson('{"foo":1}')).toThrow(/Spotify data export/);

    const api = mapSpotifyApiTracks([
      { added_at: '2024', track: { type: 'track', id: ID_A, name: 'N', artists: [{ name: 'P' }, { name: 'Q' }], album: { name: 'L' }, duration_ms: 1000, external_ids: { isrc: 'gbabc1234567' } } },
      { item: { type: 'episode', name: 'Ep' } },
      { item: { type: 'track', id: ID_B, name: 'M', artists: [{ name: 'P' }] } },
    ]);
    expect(api).toHaveLength(2);
    expect(api[0]).toEqual({ title: 'N', artists: ['P', 'Q'], artist: 'P, Q', album: 'L', durationMs: 1000, isrc: 'GBABC1234567', spotifyId: ID_A, addedAt: '2024' });
    expect(api[1].spotifyId).toBe(ID_B);
  });
});

describe('spotify match scoring', () => {
  const track: ImportedTrack = { title: 'Midnight City', artists: ['M83'], artist: 'M83', album: 'Hurry Up', durationMs: 243_000 };

  it('auto-accepts a close match and prefers the studio version', () => {
    const { verdict, ranked } = matchTrack(track, [
      { title: 'Midnight City (Live)', artist: 'M83', durationSec: 244 },
      { title: 'Midnight City', artist: 'M83 - Topic', durationSec: 244 },
    ]);
    expect(verdict).toBe('matched');
    expect(ranked[0].candidate.artist).toBe('M83 - Topic');
    expect(ranked[0].score).toBeGreaterThanOrEqual(AUTO_ACCEPT_SCORE);
    expect(ranked[1].score).toBeLessThan(AUTO_ACCEPT_SCORE);
  });

  it('sends unknown or loose durations to review and rejects far ones', () => {
    expect(matchTrack(track, [{ title: 'Midnight City', artist: 'M83' }]).verdict).toBe('review');
    const loose = matchTrack(track, [{ title: 'Midnight City', artist: 'M83', durationSec: 251 }]);
    expect(loose.verdict).toBe('review');
    expect(loose.ranked[0].score).toBeGreaterThanOrEqual(REVIEW_SCORE);
    expect(matchTrack(track, [{ title: 'Midnight City', artist: 'M83', durationSec: 260 }])).toEqual({ verdict: 'unmatched', ranked: [] });
    expect(matchTrack(track, [{ title: 'Totally Different', artist: 'Someone', durationSec: 243 }]).verdict).toBe('unmatched');
  });
});
