import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app';
import { ConfigError, defaultDataDir, loadConfig } from './config';
import { formatBanner } from './services/banner';
import { redactRelayUrl } from './services/log-redact';
import { isLoopbackUrl, pickLanUrl } from './services/network';
import { resolveToken } from './services/token-store';
import { configureCookies, cookiesStatus } from './services/ytdlp';

async function main(): Promise<void> {
  // Resolved before loadConfig so a token can be generated for a data dir that
  // loadConfig has not validated yet; loadConfig then resolves the same value.
  const bootDataDir = defaultDataDir(process.env);
  let token;
  try {
    token = resolveToken({ env: process.env, dataDir: bootDataDir });
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
  configureCookies(config.ytdlpCookiesFile, join(config.dataDir, 'cookies.txt'));

  // Computed once: the banner prints it and the cast speaker is told to use it.
  const publicUrl = process.env['PUBLIC_URL']?.trim() || undefined;
  const picked = pickLanUrl({
    publicUrl,
    host: config.host,
    port: config.port,
    interfaces: networkInterfaces(),
  });

  // loadConfig leaves this null when unset; the detected URL is host-dependent,
  // so it is resolved here rather than in config.ts (unit-testable config).
  if (config.castMediaBaseUrl === null) {
    config.castMediaBaseUrl = picked.url;
  }
  if (config.castEnabled && isLoopbackUrl(config.castMediaBaseUrl)) {
    console.warn(
      `open-record-server: cast media base URL ${config.castMediaBaseUrl} is loopback, which a cast device cannot reach; ` +
        'cast devices will not be offered (set PUBLIC_URL or CAST_MEDIA_BASE_URL to the LAN address)',
    );
    config.castMediaBaseUrl = null;
  } else {
    console.log(`open-record-server: cast media base URL ${config.castMediaBaseUrl}`);
  }

  const app = await buildApp(config, {
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      serializers: {
        req: (request: {
          method?: string;
          url?: string;
          hostname?: string;
          remoteAddress?: string;
          remotePort?: number;
        }) => ({
          method: request.method,
          url: redactRelayUrl(request.url),
          hostname: request.hostname,
          remoteAddress: request.remoteAddress,
          remotePort: request.remotePort,
        }),
      },
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });

  // Console, not the logger: the token must not reach request or app logs.
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
