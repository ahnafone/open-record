import { suggestionChips, toProviderQuery } from './search-query';

describe('search query', () => {
  it('turns decade chips into a year prefix and leaves other text alone', () => {
    expect(toProviderQuery(' 1920s ')).toBe('192');
    expect(toProviderQuery('Ragtime')).toBe('Ragtime');
    expect(
      suggestionChips([
        {
          id: 'a',
          providerId: 'p',
          title: 'A',
          artist: 'X',
          year: 1920,
          genre: 'March',
        },
        {
          id: 'b',
          providerId: 'p',
          title: 'B',
          artist: 'Y',
          year: 1897,
          genre: 'Ragtime',
        },
        {
          id: 'c',
          providerId: 'p',
          title: 'C',
          artist: 'Z',
          year: 1925,
          genre: 'Ragtime',
        },
      ]),
    ).toEqual(['Ragtime', 'March', '1920s']);
  });
});
