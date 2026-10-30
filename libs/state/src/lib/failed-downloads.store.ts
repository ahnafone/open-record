import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { Track } from '@open-record/models';
import { ImportSessionsStore } from './import-sessions.store';
import { ImportStore, type ImportCandidate } from './import.store';
import { LibraryStore } from './library.store';
import { OfflineStore, WAITING_FOR_WIFI, isSavable } from './offline.store';
import { PlayerStore } from './player.store';
import { PlaylistsStore } from './playlists.store';
import { RemoteServerPort, StreamResolverPort } from './ports';
import { isAbort, isBusy, remoteErrorMessage } from './remote-errors';
import { AGE_RESTRICTED_REASON, failureReason } from './track-format';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const NOT_A_YOUTUBE_LINK = 'Paste a YouTube or YouTube Music link to a single video.';

/**
 * Client-side allow-list for a pasted replacement link: a single YouTube or
 * YouTube Music video on youtube.com, music.youtube.com or youtu.be (no
 * playlists, channels or other hosts). Returns a canonical `watch?v=` URL
 * (playlist and tracking parameters dropped), or `null` when not allowed.
 */
export function youtubeVideoUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let id: string | null = null;
  if (SHORT_HOSTS.has(host)) {
    id = parts.length === 1 ? parts[0] : null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (parts.length === 1 && parts[0] === 'watch') id = url.searchParams.get('v');
    else if (parts.length === 2 && (parts[0] === 'shorts' || parts[0] === 'live')) id = parts[1];
  } else {
    return null;
  }
  if (!id || !VIDEO_ID.test(id)) return null;
  const base = host === 'music.youtube.com' ? 'https://music.youtube.com' : 'https://www.youtube.com';
  return `${base}/watch?v=${id}`;
}

/**
 * Canonical video id for an allowed YouTube / YouTube Music link, or `null`.
 * Lets a `music.youtube.com` and a `www.youtube.com` link to the same video
 * compare equal even though their URLs differ.
 */
export function youtubeVideoId(raw: string): string | null {
  const url = youtubeVideoUrl(raw);
  return url ? new URL(url).searchParams.get('v') : null;
}

const SAME_RECORDING = 'That’s the same recording. Pick another version or paste a different link.';

/** Friendly reason a replacement link was rejected. */
export function linkCheckError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const status = Number((error as { status?: unknown } | null)?.status);
  if (/playlist/i.test(message)) return 'That is a playlist. Paste a link to a single video.';
  if (/live stream|live event|is live|premiere/i.test(message)) return 'Live streams can’t be downloaded.';
  if (status === 415) return 'The link does not point to audio.';
  if (isBusy(error)) return remoteErrorMessage(error);
  switch (failureReason(message)) {
    case AGE_RESTRICTED_REASON:
      return 'This video is age-restricted. Add or refresh signed-in YouTube cookies on your download server, then try again.';
    case 'Private video':
      return 'This video is private.';
    case 'Blocked in region':
      return 'This video is blocked in your region.';
    case 'Video unavailable':
      return 'This video is unavailable or was removed.';
    case 'Blocked by YouTube':
      return 'YouTube blocked the download server. Try again later.';
    case 'Sign in needed':
      return 'This video needs a signed-in YouTube account.';
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'HttpError' && (status === 403 || status === 404))
    return `The audio link was refused (HTTP ${status}). Try another version.`;
  if (name === 'NetworkError' && /fetch the audio/i.test(message))
    return 'The audio could not be reached. Try another version.';
  return remoteErrorMessage(error);
}

/**
 * Tracks whose download failed for a reason of their own, and the tools to
 * fix them: retrying the same source, replacement suggestions (the import
 * review's search), checking a candidate link without downloading it, and
 * swapping a track's source.
 */
@Injectable({ providedIn: 'root' })
export class FailedDownloadsStore {
  private readonly library = inject(LibraryStore);
  private readonly offline = inject(OfflineStore);
  private readonly playlists = inject(PlaylistsStore);
  private readonly player = inject(PlayerStore);
  private readonly sessions = inject(ImportSessionsStore);
  private readonly importer = inject(ImportStore);
  private readonly remote = inject(RemoteServerPort, { optional: true });
  private readonly resolver = inject(StreamResolverPort, { optional: true });

  /** Tracks whose retry was asked for (kept listed while it is in flight). */
  private readonly retryingIds = signal<ReadonlySet<string>>(new Set());
  /** In-flight retry calls, including the record write before the queue flip. */
  private readonly pending = new Set<string>();

  constructor() {
    effect(() => {
      const retrying = this.retryingIds();
      if (!retrying.size) return;
      const next = new Set<string>();
      for (const id of retrying) {
        if (this.pending.has(id)) {
          next.add(id);
          continue;
        }
        const status = this.offline.status(id);
        if (status === 'queued' || status === 'saving') next.add(id);
      }
      if (next.size !== retrying.size) untracked(() => this.retryingIds.set(next));
    });
  }

  /** A track whose save failed for a reason of its own (not cancelled or waiting for Wi-Fi). */
  private isFailed(track: Track): boolean {
    if (!isSavable(track)) return false;
    const error = this.offline.error(track.id);
    return this.offline.status(track.id) === 'failed' && error !== 'Cancelled.' && error !== WAITING_FOR_WIFI;
  }

  /** Reactive: remote tracks whose save failed (not cancelled or waiting for Wi-Fi). */
  readonly tracks = computed<readonly Track[]>(() =>
    this.library.importedTracks().filter((t) => this.isFailed(t)),
  );

  /**
   * Reactive: failed tracks plus those being retried, so a row stays listed
   * while its retry is queued or saving instead of dropping out.
   */
  readonly listed = computed<readonly Track[]>(() =>
    this.library.importedTracks().filter((t) => isSavable(t) && (this.isRetrying(t.id) || this.isFailed(t))),
  );

  readonly count = computed(() => this.tracks().length);

  /**
   * Reactive: the track's retry is queued or saving. The status gate hides a
   * phantom "Retrying…" while the record write is still in flight.
   */
  isRetrying(trackId: string): boolean {
    if (!this.retryingIds().has(trackId)) return false;
    const status = this.offline.status(trackId);
    return status === 'queued' || status === 'saving';
  }

  /** Retry a failed track's download, keeping it listed until it is queued or saving. */
  async retry(trackId: string): Promise<void> {
    if (this.pending.has(trackId) || this.isRetrying(trackId)) return;
    this.pending.add(trackId);
    this.retryingIds.update((ids) => new Set(ids).add(trackId));
    try {
      await this.offline.retry(trackId);
      const status = this.offline.status(trackId);
      if (status !== 'queued' && status !== 'saving') this.clearRetrying(trackId);
    } catch (error) {
      this.clearRetrying(trackId);
      throw error;
    } finally {
      this.pending.delete(trackId);
    }
  }

  /** Short reason for a failed track ("Video unavailable", "Download error"...). */
  reason(trackId: string): string {
    return failureReason(this.offline.error(trackId));
  }

  /** Replacement candidates for `track` (ranked like the Spotify import review). */
  suggest(track: Track, signal: AbortSignal): Promise<ImportCandidate[]> {
    return this.importer.suggest(track, signal);
  }

  /**
   * Resolve and check a pasted link. Rejects with a user-facing Error when
   * the link is not an allowed YouTube video or cannot be downloaded.
   */
  async checkLink(raw: string, signal: AbortSignal): Promise<Track> {
    const url = youtubeVideoUrl(raw);
    if (!url) throw new Error(NOT_A_YOUTUBE_LINK);
    if (!this.remote?.configured) throw new Error('Set up a download server in Settings first.');
    let track: Track;
    try {
      track = await this.remote.resolveUrl(url, signal);
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      throw new Error(linkCheckError(error));
    }
    return this.checkCandidate(track, signal);
  }

  /**
   * Check a candidate can be downloaded: the server must hand out a stream
   * link and its first bytes must be audio (no full download). Rejects with a
   * user-facing Error; resolves to the candidate.
   */
  async checkCandidate(track: Track, signal: AbortSignal): Promise<Track> {
    const url = track.source?.url;
    if (!url || !youtubeVideoUrl(url)) throw new Error(NOT_A_YOUTUBE_LINK);
    if (!this.resolver?.probe) throw new Error('Checking links is not available in this build.');
    try {
      await this.resolver.probe(url, signal);
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      throw new Error(linkCheckError(error));
    }
    return track;
  }

  /**
   * Point a failed track at a checked `candidate`, keeping the user's
   * metadata, bookmark and playlist places, and queue its download now.
   */
  async replace(oldId: string, candidate: Track): Promise<Track> {
    await Promise.all([this.library.ready(), this.playlists.ready()]);
    const old = this.library.track(oldId);
    if (!old) throw new Error('This song is no longer in your library.');
    if (!candidate.source?.url || !youtubeVideoUrl(candidate.source.url)) throw new Error(NOT_A_YOUTUBE_LINK);
    const next = this.swappedSource(old, candidate);
    if (next.id === oldId) {
      // Same video: nothing to migrate, just try again.
      await this.retry(oldId);
      return next;
    }
    this.offline.forget([oldId]);
    await this.library.replaceTrackId(oldId, next);
    await this.playlists.replaceTrackEverywhere(oldId, next.id);
    await this.player.replaceTrack(oldId, next);
    await this.sessions.replaceTrackId(oldId, next.id);
    await this.importer.replaceMatchId(oldId, next);
    await this.offline.ensureSaved(next);
    return next;
  }

  /**
   * Replace the source of the record that failed to play, then start it.
   * The queue swap happens before the library/playlist migration so a queue
   * rejection leaves the library untouched. A failed queue play still keeps
   * the source change for the rest of the queue.
   */
  async replaceForPlayback(
    oldId: string,
    candidate: Track,
  ): Promise<{ track: Track; current: boolean }> {
    await Promise.all([this.library.ready(), this.playlists.ready()]);
    const old =
      this.library.track(oldId) ??
      (this.player.current()?.id === oldId ? this.player.current() : null);
    if (!old) throw new Error('That record is no longer available.');
    if (!candidate.source?.url || !youtubeVideoUrl(candidate.source.url)) throw new Error(NOT_A_YOUTUBE_LINK);
    const oldVideo = old.source?.url ? youtubeVideoId(old.source.url) : null;
    const candidateVideo = youtubeVideoId(candidate.source.url);
    if (oldVideo && candidateVideo && oldVideo === candidateVideo) throw new Error(SAME_RECORDING);
    if (this.player.current()?.id !== oldId) throw new Error('That record is no longer playing.');

    const wasStored = !!this.library.storedRecord(oldId);
    const next = this.swappedSource(old, candidate);
    const current = await this.player.replaceTrack(oldId, next, { playCurrent: true });
    // The queue now points at the new id: stop any save still working on the
    // old one before its record is migrated away.
    this.offline.forget([oldId]);
    await this.library.replaceTrackId(oldId, next);
    await this.playlists.replaceTrackEverywhere(oldId, next.id);
    await this.sessions.replaceTrackId(oldId, next.id);
    await this.importer.replaceMatchId(oldId, next);
    if (wasStored) {
      // The source change and playback already happened: a download
      // scheduling failure must not turn that into a failed fix.
      try {
        await this.offline.ensureSaved(next);
      } catch {
        // The save can be retried from Failed downloads.
      }
    }
    return { track: next, current };
  }

  /** Keep the old track's metadata and swap in the candidate's source/id. */
  private swappedSource(old: Track, candidate: Track): Track {
    const next: Track = {
      ...old,
      id: candidate.id,
      providerId: candidate.providerId,
      source: candidate.source,
    };
    delete next.sourceFile;
    delete next.sizeBytes;
    if (candidate.durationSec) next.durationSec = candidate.durationSec;
    else delete next.durationSec;
    if (!old.artUrl && candidate.artUrl) next.artUrl = candidate.artUrl;
    return next;
  }

  /** Drop a track id from the retrying set (no write when it is not there). */
  private clearRetrying(trackId: string): void {
    if (!this.retryingIds().has(trackId)) return;
    this.retryingIds.update((ids) => {
      const next = new Set(ids);
      next.delete(trackId);
      return next;
    });
  }
}
