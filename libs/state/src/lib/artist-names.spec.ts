import { albumKey, artistKey, splitArtists } from '@open-record/models';

describe('splitArtists', () => {
  it('splits on comma, semicolon, ampersand and feat./ft./featuring', () => {
    expect(splitArtists('A, B; C & D')).toEqual(['A', 'B', 'C', 'D']);
    expect(splitArtists('Drake feat. Future')).toEqual(['Drake', 'Future']);
    expect(splitArtists('Drake FT Future')).toEqual(['Drake', 'Future']);
    expect(splitArtists('Drake featuring Future')).toEqual(['Drake', 'Future']);
  });

  it('handles feat. groups in parentheses and brackets', () => {
    expect(splitArtists('Artist (feat. X)')).toEqual(['Artist', 'X']);
    expect(splitArtists('Artist [ft. X, Y]')).toEqual(['Artist', 'X', 'Y']);
  });

  it('keeps allowlisted bands whole and does not split on words inside names', () => {
    expect(splitArtists('Simon & Garfunkel')).toEqual(['Simon & Garfunkel']);
    expect(splitArtists('Tyler, The Creator feat. Frank Ocean')).toEqual([
      'Tyler, The Creator',
      'Frank Ocean',
    ]);
    expect(splitArtists('Earth, Wind & Fire')).toEqual(['Earth, Wind & Fire']);
    expect(splitArtists('Deftones')).toEqual(['Deftones']);
    expect(splitArtists('AC/DC')).toEqual(['AC/DC']);
  });

  it('dedupes by key, drops empties and returns [] for unknown artists', () => {
    expect(splitArtists('Adele, adele ,, ')).toEqual(['Adele']);
    expect(splitArtists('Unknown artist')).toEqual([]);
    expect(splitArtists('')).toEqual([]);
  });
});

describe('artistKey / albumKey', () => {
  it('folds diacritics, case and whitespace', () => {
    expect(artistKey('  Beyoncé   Knowles ')).toBe('beyonce knowles');
    expect(albumKey('25', 'Adele')).toBe('adele::25');
    expect(albumKey('Ôkay', 'Beyoncé')).toBe(albumKey('okay', 'BEYONCE'));
  });

  it('strips only Latin accents, so kana and other scripts stay distinct', () => {
    expect(artistKey('é')).toBe('e');
    expect(artistKey('Ü')).toBe('u');
    expect(artistKey('が')).not.toBe(artistKey('か'));
    expect(artistKey('が')).toBe(artistKey('が'));
  });
});
