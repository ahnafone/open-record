import { InMemoryBackend } from './adapters/memory';
import {
  COLLECTIONS,
  MIGRATIONS,
  Migration,
  SETTINGS_KEYS,
  latestVersion,
  runMigrations,
} from './migrations';

describe('runMigrations', () => {
  it('upgrades a fresh (v0) store to the latest schema with every collection', async () => {
    const backend = new InMemoryBackend();
    const result = await runMigrations(backend);

    expect(result.from).toBe(0);
    expect(result.to).toBe(latestVersion());
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(backend.version).toBe(latestVersion());
    for (const name of Object.values(COLLECTIONS)) {
      expect(backend.tables.has(name)).toBe(true);
    }
  });

  it('is idempotent: a second run applies nothing and keeps data', async () => {
    const backend = new InMemoryBackend();
    await runMigrations(backend);
    await backend.put(COLLECTIONS.settings, 'theme', 'dark');

    const again = await runMigrations(backend);

    expect(again.applied).toEqual([]);
    expect(await backend.get(COLLECTIONS.settings, 'theme')).toBe('dark');
  });

  it('runs only newer migrations in order, including data transforms', async () => {
    const order: number[] = [];
    const next = latestVersion() + 1;
    const v2: Migration = {
      version: next,
      description: 'rename setting',
      async up(ctx) {
        order.push(next);
        for (const [key, value] of await ctx.entries(COLLECTIONS.settings)) {
          await ctx.delete(COLLECTIONS.settings, key);
          await ctx.put(COLLECTIONS.settings, `ui.${key}`, value);
        }
      },
    };
    const backend = new InMemoryBackend();
    await runMigrations(backend, MIGRATIONS);
    await backend.put(COLLECTIONS.settings, 'theme', 'dark');

    const result = await runMigrations(backend, [...MIGRATIONS, v2]);

    expect(result).toEqual({ from: next - 1, to: next, applied: [next] });
    expect(order).toEqual([next]);
    expect(await backend.get(COLLECTIONS.settings, 'ui.theme')).toBe('dark');
  });

  it('rolls back a failing migration and leaves the version unchanged', async () => {
    const backend = new InMemoryBackend();
    await runMigrations(backend);
    const broken: Migration = {
      version: latestVersion() + 1,
      description: 'fails',
      async up(ctx) {
        await ctx.createCollection('half_done');
        throw new Error('boom');
      },
    };

    await expect(
      runMigrations(backend, [...MIGRATIONS, broken]),
    ).rejects.toThrow('boom');
    expect(backend.version).toBe(latestVersion());
    expect(backend.tables.has('half_done')).toBe(false);
  });

  it('refuses to downgrade and rejects non-contiguous migration lists', async () => {
    const backend = new InMemoryBackend();
    backend.version = 99;
    await expect(runMigrations(backend)).rejects.toThrow(/downgrade/);

    const gap: Migration = {
      version: latestVersion() + 2,
      description: 'gap',
      up: async () => undefined,
    };
    await expect(
      runMigrations(new InMemoryBackend(), [...MIGRATIONS, gap]),
    ).rejects.toThrow(/contiguous/);
  });

  it('v2 backfills imported tracks and defaults onlineMetadata to on', async () => {
    const backend = new InMemoryBackend();
    await runMigrations(backend, MIGRATIONS.slice(0, 1));
    await backend.put(COLLECTIONS.importedTracks, 'local:1', {
      track: { id: 'local:1', providerId: 'local', title: 'T', artist: 'A' },
      filePath: 'imported/1.audio.mp3',
      importedAt: 1,
    });

    const result = await runMigrations(backend, MIGRATIONS.slice(0, 2));

    expect(result.applied).toEqual([2]);
    expect(
      await backend.get(COLLECTIONS.importedTracks, 'local:1'),
    ).toMatchObject({
      track: { sourceFile: 'imported/1.audio.mp3', enrichment: 'none' },
    });
    expect(
      await backend.get(COLLECTIONS.settings, SETTINGS_KEYS.onlineMetadata),
    ).toBe(true);
  });

  it('v2 keeps an existing onlineMetadata choice', async () => {
    const backend = new InMemoryBackend();
    await runMigrations(backend, MIGRATIONS.slice(0, 1));
    await backend.put(COLLECTIONS.settings, SETTINGS_KEYS.onlineMetadata, false);
    await runMigrations(backend, MIGRATIONS.slice(0, 2));
    expect(
      await backend.get(COLLECTIONS.settings, SETTINGS_KEYS.onlineMetadata),
    ).toBe(false);
  });
});
