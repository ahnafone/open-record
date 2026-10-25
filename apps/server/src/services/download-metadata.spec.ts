import { describe, expect, it, vi } from 'vitest';
import { createMetadataPostProcess } from './download-metadata';
import type { DownloadJob } from './downloads';

function job(): DownloadJob {
  return {
    id: 'j1',
    url: 'https://example.com/v',
    status: 'processing',
    progress: 99,
    createdAt: 0,
    track: { title: 'M83 - Midnight City (Official Video)', artist: 'M83VEVO', durationSec: 244 },
  };
}

describe('metadata post-process', () => {
  it('updates job.track from a match', async () => {
    const enrich = vi.fn().mockResolvedValue({
      title: 'Midnight City',
      artist: 'M83',
      album: "Hurry Up, We're Dreaming",
      year: 2011,
      genre: 'Electronic',
      artworkUrl: 'https://is1-ssl.mzstatic.com/a.jpg',
      source: 'itunes',
    });
    const j = job();
    await createMetadataPostProcess({}, enrich)(j, '/tmp/x.m4a', null);
    expect(enrich).toHaveBeenCalledWith(
      '/tmp/x.m4a',
      { title: 'M83 - Midnight City (Official Video)', artist: 'M83VEVO', durationSec: 244 },
      {},
    );
    expect(j.track).toEqual({
      title: 'Midnight City',
      artist: 'M83',
      album: "Hurry Up, We're Dreaming",
      year: 2011,
      genre: 'Electronic',
      artworkUrl: 'https://is1-ssl.mzstatic.com/a.jpg',
      durationSec: 244,
    });
  });

  it('leaves job.track unchanged on a null match', async () => {
    const j = job();
    const before = structuredClone(j.track);
    await createMetadataPostProcess({}, vi.fn().mockResolvedValue(null))(j, '/tmp/x.m4a', null);
    expect(j.track).toEqual(before);
  });
});
