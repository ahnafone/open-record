import { CatalogProvider } from './catalog-provider';

describe('CatalogProvider.list', () => {
  const provider = new CatalogProvider();

  it('exposes the entry audio file as catalogFile and never leaks audioFile', async () => {
    const tracks = await provider.list();
    const sandman = tracks.find((t) => t.id === 'catalog:sandman');

    expect(sandman?.catalogFile).toBe('japanese-sandman.mp3');
    for (const track of tracks) {
      expect(track).not.toHaveProperty('audioFile');
      expect(track.catalogFile).toEqual(expect.any(String));
    }
  });
});

describe('CatalogProvider.search', () => {
  const provider = new CatalogProvider();
  const titles = async (q: string) => (await provider.search(q)).map((t) => t.title);

  it('matches title, artist, year and genre case-insensitively', async () => {
    expect(await titles('SANDMAN')).toEqual(['The Japanese Sandman']);
    expect(await titles('sousa')).toEqual(["Columbia's Pride (March)"]);
    expect(await titles('1920')).toEqual(['The Japanese Sandman', 'Afghanistan (Fox Trot)']);
    expect(await titles('ragtime')).toEqual(['Harlem Rag (Two Step)']);
  });

  it('returns everything for a blank query and nothing for no match', async () => {
    expect(await provider.search('  ')).toHaveLength(5);
    expect(await provider.search('no such record')).toEqual([]);
  });
});
