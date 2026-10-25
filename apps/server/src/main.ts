import { mkdir } from 'node:fs/promises';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { createMetadataPostProcess } from './services/download-metadata';
import { setPostProcess } from './services/downloads';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`open-record-server: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  await mkdir(config.dataDir, { recursive: true });

  const app = await buildApp(config, { logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });
  // Registered here (not in buildApp) so tests keep the no-op hook.
  setPostProcess(createMetadataPostProcess({ log: app.log }));

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
