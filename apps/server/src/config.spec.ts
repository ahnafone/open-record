import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './config';

/** A valid required token; each test overrides only what it checks. */
const BASE: Record<string, string> = { OPEN_RECORD_TOKEN: '0123456789abcdef' };

function load(extra: Record<string, string> = {}) {
  return loadConfig({ ...BASE, ...extra });
}

describe('loadConfig', () => {
  it('uses the documented defaults', () => {
    const config = load();
    expect(config.dataDir).toBe(join(homedir(), '.config', 'open-record'));
    expect(config.rateLimitMax).toBe(600);
    expect(config.castEnabled).toBe(true);
    expect(config.castMediaBaseUrl).toBeNull();
    expect(config.castRelayTtlSec).toBe(900);
    expect(config.castCacheMb).toBe(2048);
    expect(config.castUploadMaxMb).toBe(200);
    expect(config.sessionEnabled).toBe(true);
    expect(config.sessionIdleTimeoutMin).toBe(120);
    expect(config.sessionTargetStaleMin).toBe(30);
    expect(config.ffmpegPath).toBe('ffmpeg');
  });

  it('parses every new variable from the environment', () => {
    const config = load({
      OPEN_RECORD_DATA_DIR: '/srv/open-record',
      RATE_LIMIT_MAX: '900',
      CAST_ENABLED: 'false',
      CAST_MEDIA_BASE_URL: 'http://192.168.1.20:8787///',
      CAST_RELAY_TTL_SEC: '120',
      CAST_CACHE_MB: '0',
      CAST_UPLOAD_MAX_MB: '512',
      SESSION_ENABLED: 'false',
      SESSION_IDLE_TIMEOUT_MIN: '45',
      SESSION_TARGET_STALE_MIN: '10',
      FFMPEG_PATH: '/usr/local/bin/ffmpeg',
    });
    expect(config.dataDir).toBe('/srv/open-record');
    expect(config.rateLimitMax).toBe(900);
    expect(config.castEnabled).toBe(false);
    expect(config.castMediaBaseUrl).toBe('http://192.168.1.20:8787');
    expect(config.castRelayTtlSec).toBe(120);
    expect(config.castCacheMb).toBe(0);
    expect(config.castUploadMaxMb).toBe(512);
    expect(config.sessionEnabled).toBe(false);
    expect(config.sessionIdleTimeoutMin).toBe(45);
    expect(config.sessionTargetStaleMin).toBe(10);
    expect(config.ffmpegPath).toBe('/usr/local/bin/ffmpeg');
  });

  it('accepts the strict boolean spellings case-insensitively', () => {
    expect(load({ CAST_ENABLED: '1' }).castEnabled).toBe(true);
    expect(load({ CAST_ENABLED: 'TRUE' }).castEnabled).toBe(true);
    expect(load({ CAST_ENABLED: 'False' }).castEnabled).toBe(false);
    expect(load({ SESSION_ENABLED: '1' }).sessionEnabled).toBe(true);
    expect(load({ SESSION_ENABLED: 'FALSE' }).sessionEnabled).toBe(false);
    expect(load({ SESSION_ENABLED: '0' }).sessionEnabled).toBe(false);
  });

  it('falls back to "ffmpeg" for a blank FFMPEG_PATH', () => {
    expect(load({ FFMPEG_PATH: '   ' }).ffmpegPath).toBe('ffmpeg');
  });

  it.each<[string, Record<string, string>]>([
    ['a relay TTL of 0', { CAST_RELAY_TTL_SEC: '0' }],
    ['a relay TTL above the cap', { CAST_RELAY_TTL_SEC: '86401' }],
    ['a negative cache size', { CAST_CACHE_MB: '-1' }],
    ['a cache size above the cap', { CAST_CACHE_MB: '1048577' }],
    ['an upload cap of 0', { CAST_UPLOAD_MAX_MB: '0' }],
    ['an upload cap above the cap', { CAST_UPLOAD_MAX_MB: '4097' }],
    ['an idle timeout of 0', { SESSION_IDLE_TIMEOUT_MIN: '0' }],
    ['an idle timeout above the cap', { SESSION_IDLE_TIMEOUT_MIN: '1441' }],
    ['a stale timeout of 0', { SESSION_TARGET_STALE_MIN: '0' }],
    ['a stale timeout above the cap', { SESSION_TARGET_STALE_MIN: '1441' }],
    ['a malformed cast media URL', { CAST_MEDIA_BASE_URL: 'ftp://example.com' }],
    ['a cast media URL without a host', { CAST_MEDIA_BASE_URL: 'http://' }],
    ['an invalid cast boolean', { CAST_ENABLED: 'yes' }],
    ['an invalid session boolean', { SESSION_ENABLED: 'maybe' }],
  ])('rejects %s', (_label, env) => {
    expect(() => load(env)).toThrow(ConfigError);
  });
});
