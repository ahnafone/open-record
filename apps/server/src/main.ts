import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { formatBanner } from './services/banner';
import { pickLanUrl } from './services/network';
import { defaultDataDir, resolveToken } from './services/token-store';
import { configureCookies, cookiesStatus } from './services/ytdlp';

async function main(): Promise<void> {
  const dataDir = defaultDataDir(process.env);
  let token;
  try {
    token = resolveToken({ env: process.env, dataDir });
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

  // Here rather than in buildApp on purpose: specs call buildApp, and the
  // fallback jar must not make server tests depend on whether the developer's
  // own ~/.config/open-record/cookies.txt happens to exist.
  configureCookies(config.ytdlpCookiesFile, join(dataDir, 'cookies.txt'));

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
      cookies: cookiesStatus(),
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
