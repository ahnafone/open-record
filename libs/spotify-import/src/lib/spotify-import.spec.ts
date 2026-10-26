import { AUTO_ACCEPT_SCORE, REVIEW_SCORE, matchTrack } from './match';
import { parseDataDownloadJson, parseImportFile } from './parsers';
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
    // Exportify's Export All names the Liked Songs file `liked.csv`.
    expect(parseImportFile('liked.csv', csv)).toMatchObject({ playlists: [], liked: [{}, {}] });
    expect(parseImportFile('likes_2024.csv', csv).playlists).toHaveLength(1);
    expect(() => parseImportFile('x.csv', 'foo,bar\n1,2')).toThrow(/Exportify/);
    expect(() => parseImportFile('my_spotify_data.zip', '')).toThrow(/Unzip/);
  });

  it('parses data-download JSON, skipping episodes and nulls', () => {
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

  it('matches a YouTube upload with a piped suffix and non-Latin brackets', () => {
    const nine: ImportedTrack = { title: 'Cheye Dekho', artists: ['NINE'], artist: 'NINE', durationMs: 302_000 };
    const result = matchTrack(nine, [
      { title: 'NINE - Cheye Dekho (চেয়ে দেখো) | Official Lyric Video | Band NINE', artist: 'Band NINE', durationSec: 305 },
    ]);
    expect(result.verdict).toBe('matched');
  });

  it('matches a song titled in another script when artist and duration agree', () => {
    const jp: ImportedTrack = { title: 'インザバックルーム', artists: ['syudou'], artist: 'syudou', durationMs: 206_000 };
    const result = matchTrack(jp, [{ title: 'syudou - In the Back Room', artist: 'syudou', durationSec: 206 }]);
    expect(result.verdict).toBe('matched');
  });

  it('offers an official MV titled in another script for review when the duration is only loosely close', () => {
    const jp: ImportedTrack = { title: '強火', artists: ['Queen Bee'], artist: 'Queen Bee', durationMs: 208_013 };
    const result = matchTrack(jp, [
      { title: 'HIGH FLAME, off vocal version', artist: 'QUEEN BEE', durationSec: 209 },
      { title: '『HIGH FLAME』Official MV', artist: '女王蜂 / QUEEN BEE official YouTube channel', durationSec: 212 },
    ]);
    expect(result.verdict).toBe('review');
    expect(result.ranked[0].candidate.title).toBe('『HIGH FLAME』Official MV');
  });

  it('matches via catalogue aliases when artist and title are in another script and duration is absent', () => {
    const jp: ImportedTrack = { title: '馬と鹿', artists: ['米津玄師'], artist: '米津玄師' };
    const upload = { title: 'Kenshi Yonezu - Uma to Shika (Official Video)', artist: 'Kenshi Yonezu' };
    expect(matchTrack(jp, [upload]).verdict).toBe('unmatched');
    const aliases = { titles: ['馬と鹿', 'Uma to Shika'], artists: ['米津玄師', 'Kenshi Yonezu', 'Yonezu, Kenshi'] };
    const result = matchTrack(jp, [upload], aliases);
    expect(result.verdict).toBe('review');
    expect(result.ranked[0].score).toBeGreaterThanOrEqual(0.9);
    // Aliases do not rescue an unrelated song by another artist.
    expect(matchTrack(jp, [{ title: 'Lemon Tree', artist: "Fool's Garden", durationSec: 190 }], aliases).verdict).toBe('unmatched');
  });

  it('matches an upload with a bracketed translation in another script', () => {
    const jp: ImportedTrack = { title: 'シャッター', artists: ['Yuuri'], artist: 'Yuuri', durationMs: 248_947 };
    const upload = { title: 'Yuuri - シャッター (Shutter) (kanji/romaji/english lyrics)', artist: 'Alfa Hana', durationSec: 253 };
    expect(matchTrack(jp, [upload]).verdict).toBe('matched');
  });

  it('compares romanised kana and Cyrillic offline', () => {
    const kana: ImportedTrack = { title: 'さくらんぼ', artists: ['大塚愛'], artist: '大塚愛', durationMs: 248_000 };
    const kanaResult = matchTrack(kana, [{ title: '大塚愛 - Sakuranbo', artist: 'ai otsuka', durationSec: 248 }]);
    expect(kanaResult.ranked[0].titleScore).toBe(1);
    const ru: ImportedTrack = { title: 'Группа крови', artists: ['Кино'], artist: 'Кино', durationMs: 285_000 };
    expect(matchTrack(ru, [{ title: 'Kino - Gruppa krovi', artist: 'Kino', durationSec: 286 }]).verdict).toBe('matched');
  });
});
