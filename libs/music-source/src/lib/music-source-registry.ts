import type { PlayableSource, Track } from '@open-record/models';
import type { MusicSourceProvider } from './music-source-provider';

/**
 * Holds the providers registered at startup. The UI and state layers talk to
 * the registry only, never to a concrete provider.
 */
export class MusicSourceRegistry {
  private readonly providers = new Map<string, MusicSourceProvider>();

  register(provider: MusicSourceProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Music source provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): MusicSourceProvider | undefined {
    return this.providers.get(id);
  }

  list(): MusicSourceProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Search every provider that supports search and merge the results in
   * registration order. A failing provider is skipped so one broken source
   * does not hide results from the others.
   */
  async searchAll(query: string): Promise<Track[]> {
    const searchable = this.list().filter((p) => p.capabilities.search);
    const results = await Promise.allSettled(searchable.map((p) => p.search(query)));
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }

  /**
   * Every listable track from providers that implement `list`, in
   * registration order. Failing providers are skipped, as in `searchAll`.
   */
  async listAll(): Promise<Track[]> {
    const listable = this.list().filter((p) => typeof p.list === 'function');
    const results = await Promise.allSettled(listable.map((p) => p.list?.() ?? []));
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }

  /** Route resolution to the provider that owns the track. */
  resolve(track: Pick<Track, 'id' | 'providerId'>): Promise<PlayableSource> {
    const provider = this.providers.get(track.providerId);
    if (!provider) {
      return Promise.reject(
        new Error(`No music source provider registered for "${track.providerId}"`),
      );
    }
    return provider.resolve(track.id);
  }
}
