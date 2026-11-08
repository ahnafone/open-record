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

  // Behind a reverse proxy without a trust setting, request.ip is the proxy's
  // loopback address, so every guest shares one per-IP bucket.
  if (config.guestStreaming && config.trustProxy === false && !config.trustCfConnectingIp) {
    console.warn(
      [
        '',
        '*** WARNING: GUEST_STREAMING=true but neither TRUST_PROXY nor TRUST_CF_CONNECTING_IP is set. ***',
        '*** Behind a reverse proxy, every guest shares ONE per-IP limit (the proxy address). ***',
        '*** Set TRUST_CF_CONNECTING_IP=true only when a proxy that overwrites CF-Connecting-IP is the only path to the origin, ***',
        '*** or TRUST_PROXY=<proxy address> when a reverse proxy adds X-Forwarded-For. ***',
        '',
      ].join('\n'),
    );
  }

  // With one yt-dlp slot in total, guests never get one (the last slot is kept
  // for signed-in callers), so every guest request answers 503 guest_busy.
  if (config.guestStreaming && config.maxConcurrentResolves <= 1) {
    console.warn(
      'open-record-server: GUEST_STREAMING=true but MAX_CONCURRENT_RESOLVES is 1: ' +
        'guests never get a yt-dlp slot and will get 503 guest_busy. Set MAX_CONCURRENT_RESOLVES to 2 or more.',
    );
  }

  // Names only: the service-role key and admin id are never printed.
  if (config.requireApproval) {
    console.log(
      'open-record-server: approval gate on (REQUIRE_APPROVAL): Supabase users need an approved access request',
    );
  }

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
  // With a relay port, speakers get the LAN address on that port. PUBLIC_URL is
  // deliberately skipped: it is the public hostname, which a speaker should not
  // fetch media through (router hairpin, public upload bandwidth).
  const castRelayPort = config.castRelayPort;
  const relayPicked =
    castRelayPort !== null
      ? pickLanUrl({ host: config.castRelayHost, port: castRelayPort, interfaces: networkInterfaces() })
      : null;
  if (config.castMediaBaseUrl === null) {
    config.castMediaBaseUrl = relayPicked?.url ?? picked.url;
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

  if (app.castRelayListener && castRelayPort !== null) {
    await app.castRelayListener.listen({ port: castRelayPort, host: config.castRelayHost });
    console.log(
      `open-record-server: cast relay listening on ${config.castRelayHost}:${castRelayPort} (relay route only)`,
    );
  } else if (castRelayPort !== null) {
    console.log('open-record-server: CAST_RELAY_PORT is set but casting is off; no relay listener started');
  }

  // Console, not the logger: the token must not reach request or app logs.
  // The desktop owns the token, so it suppresses the banner entirely.
  if (!config.quietStartup) {
    console.log(
      await formatBanner({
        ...picked,
        fromPublicUrl: !!publicUrl,
        token,
        cookies: cookiesStatus(),
      }),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
