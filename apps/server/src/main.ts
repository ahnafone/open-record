import { networkInterfaces } from 'node:os';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { formatBanner } from './services/banner';
import { pickLanUrl } from './services/network';
import { defaultDataDir, resolveToken } from './services/token-store';

async function main(): Promise<void> {
  let token;
  try {
    token = resolveToken({ env: process.env, dataDir: defaultDataDir(process.env) });
  } catch (err) {
    console.error(`open-record-server: ${(err as Error).message}`);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig({ ...process.env, OPEN_RECORD_TOKEN: token.token });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`open-record-server: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const app = await buildApp(config, { logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });

  // Console, not the logger: the token must not reach request or app logs.
  const publicUrl = process.env['PUBLIC_URL']?.trim() || undefined;
  const picked = pickLanUrl({
    publicUrl,
    host: config.host,
    port: config.port,
    interfaces: networkInterfaces(),
  });
  console.log(
    await formatBanner({
      ...picked,
      fromPublicUrl: !!publicUrl,
      token,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
