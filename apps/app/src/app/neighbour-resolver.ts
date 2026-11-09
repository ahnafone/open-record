import type { PlayableSource, Track } from '@open-record/models';

/**
 * Neighbour source for the player's pre-buffering. Native engines get the
 * window via `load`, so an unsaved remote track is left out there (no stream
 * request for a neighbour the user may never reach). Web engines preload
 * through `preload`: unsaved remote tracks resolve the same way playback does,
 * so the preloaded URL equals the one a later load asks for and the warm
 * element is adopted. Both paths share the server's link cache.
 */
export function createNeighbourResolver(deps: {
  native: boolean;
  remoteProviderId: string;
  resolve: (track: Track) => Promise<PlayableSource>;
  resolveSaved: (trackId: string) => Promise<PlayableSource | undefined>;
}): (track: Track) => Promise<PlayableSource | undefined> {
  return (track) =>
    deps.native && track.providerId === deps.remoteProviderId
      ? deps.resolveSaved(track.id)
      : deps.resolve(track);
}
