import { normalizeGenre } from './genre';

describe('normalizeGenre', () => {
  it('merges known aliases case-insensitively onto one label', () => {
    expect(['Hip-Hop/Rap', 'Rap', 'hip hop', 'Hip Hop'].map(normalizeGenre)).toEqual([
      'Hip-Hop',
      'Hip-Hop',
      'Hip-Hop',
      'Hip-Hop',
    ]);
    expect(['R&B/Soul', 'RnB', 'R and B'].map(normalizeGenre)).toEqual(['R&B/Soul', 'R&B/Soul', 'R&B/Soul']);
    expect(['Electronica', 'Electronic', 'Dance/Electronic'].map(normalizeGenre)).toEqual([
      'Electronic',
      'Electronic',
      'Electronic',
    ]);
  });

  it('keeps unknown genres as given, tidied', () => {
    expect(normalizeGenre('  K-Pop  ')).toBe('K-Pop');
    expect(normalizeGenre('Fox   trot')).toBe('Fox trot');
  });

  it('returns undefined for blank input', () => {
    expect(normalizeGenre(undefined)).toBeUndefined();
    expect(normalizeGenre('   ')).toBeUndefined();
  });
});
