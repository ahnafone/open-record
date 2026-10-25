import type { DownloadTrack, PostProcessHook } from './downloads';
import { enrichFile, type EnrichOptions } from './metadata';

type Enrich = typeof enrichFile;

/**
 * Post-process hook that looks the finished download up on iTunes/Deezer,
 * re-tags the file and copies the match into `job.track`. Never throws, so
 * a failed lookup leaves the job (and yt-dlp's metadata) as it was.
 */
export function createMetadataPostProcess(opts: EnrichOptions = {}, enrich: Enrich = enrichFile): PostProcessHook {
  return async (job, filePath) => {
    const track = job.track;
    if (!track) return;
    try {
      const match = await enrich(
        filePath,
        { title: track.title, artist: track.artist || undefined, durationSec: track.durationSec },
        opts,
      );
      if (!match) return;
      const next: DownloadTrack = { ...track, title: match.title, artist: match.artist };
      if (match.album) next.album = match.album;
      if (match.year !== undefined) next.year = match.year;
      if (match.genre) next.genre = match.genre;
      if (match.artworkUrl) next.artworkUrl = match.artworkUrl;
      job.track = next;
    } catch (err) {
      opts.log?.warn({ err: String(err) }, 'metadata post-process failed');
    }
  };
}
