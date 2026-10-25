import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { createIndexedDbStorage } from './adapters/indexeddb';
import { createSqliteStorage } from './adapters/sqlite';
import { StoragePort } from './storage-port';

export interface StorageOptions {
  /** Database name for both adapters. Defaults to `open-record`. */
  name?: string;
}

/** SQLite on native platforms, IndexedDB on the web. */
export function createPlatformStorage(
  options: StorageOptions = {},
): StoragePort {
  return Capacitor.isNativePlatform()
    ? createSqliteStorage(options.name)
    : createIndexedDbStorage(options.name);
}

/** Registers `StoragePort` for the app. Add to `ApplicationConfig.providers`. */
export function provideStorage(
  options: StorageOptions = {},
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: StoragePort, useFactory: () => createPlatformStorage(options) },
  ]);
}
