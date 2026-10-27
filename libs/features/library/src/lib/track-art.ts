import { inject } from '@angular/core';
import type { Track } from '@open-record/models';
import { TrackArtService } from '@open-record/state';
import type { SleeveSrc } from '@open-record/ui';

/**
 * Sleeve art for a track (see {@link TrackArtService}); every caller shares
 * the service's app-wide cache. Call in an injection context.
 */
export function injectTrackArt(): (track: Track | null | undefined) => SleeveSrc {
  const service = inject(TrackArtService);
  return (track) => service.art(track);
}
