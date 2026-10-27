import { HIGH_CONFIDENCE, mergeCandidates, scoreCandidate } from './enrich';

describe('enrichment match scoring', () => {
  const query = { title: 'Blinding Lights (Official Video)', artist: 'The Weeknd', durationSec: 201 };

  it('trusts the same song and rejects other versions, artists and lengths', () => {
    expect(scoreCandidate(query, { title: 'Blinding Lights', artist: 'The Weeknd', durationSec: 200 })).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
    expect(scoreCandidate(query, { title: 'Blinding Lights (Live)', artist: 'The Weeknd', durationSec: 203 })).toBeLessThan(HIGH_CONFIDENCE);
    expect(scoreCandidate(query, { title: 'Blinding Lights', artist: 'Some Cover Band', durationSec: 201 })).toBeLessThan(HIGH_CONFIDENCE);
    expect(scoreCandidate(query, { title: 'Blinding Lights', artist: 'The Weeknd', durationSec: 260 })).toBeLessThan(HIGH_CONFIDENCE);
  });

  it('prefers the higher-priority source and fills gaps from the others', () => {
    const match = mergeCandidates(query, [
      { source: 'deezer', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', artUrl: 'https://x/d.jpg', durationSec: 200 },
      { source: 'itunes', title: 'Blinding Lights', artist: 'The Weeknd', genre: 'R&B/Soul', durationSec: 200 },
      { source: 'ytmusic', title: 'Wrong Song', artist: 'Nobody' },
    ]);
    expect(match).toMatchObject({ sources: ['itunes', 'deezer'], genre: 'R&B/Soul', album: 'After Hours', artUrl: 'https://x/d.jpg' });
  });
});
