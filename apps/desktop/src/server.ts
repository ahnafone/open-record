import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, writeFileSync, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { delimiter, join } from 'node:path';
import type { DesktopConfig } from './config';

/** Fixed loopback origin. IndexedDB/localStorage are keyed by it, so it never changes. */
export const SERVER_HOST = '127.0.0.1';
export const SERVER_PORT = 47_900;
export const SERVER_ORIGIN = `http://${SERVER_HOST}:${SERVER_PORT}`;

const HEALTH_POLL_MS = 150;
const HEALTH_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const MAX_LOG_LINE = 16 * 1024;

/** Packaged: extraResources. Dev: the workspace dist folders. */
export function resolveResourcePaths(isPackaged: boolean, resourcesPath: string, mainDir: string): {
  serverDir: string;
  webDir: string;
  binDir: string;
} {
  if (isPackaged) {
    return {
      serverDir: join(resourcesPath, 'server'),
      webDir: join(resourcesPath, 'app', 'browser'),
      binDir: join(resourcesPath, 'bin'),
    };
  }
  // dist/apps/desktop/main/main.cjs -> workspace root
  const root = join(mainDir, '..', '..', '..', '..');
  return {
    serverDir: join(root, 'dist', 'apps', 'desktop', 'server'),
    webDir: join(root, 'dist', 'apps', 'app', 'browser'),
    binDir: join(root, 'dist', 'apps', 'desktop', 'bin'),
  };
}

export interface ResourcePaths {
  serverDir: string;
  webDir: string;
  binDir: string;
}

/**
 * Reads the desktop-owned token, or creates it mode 0600. The server gets it
 * through the environment, so the startup banner is never needed.
 */
export function readOrCreateToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'token');

  const read = (): string | null => {
    try {
      const value = readFileSync(path, 'utf8').trim();
      return value.length >= 16 ? value : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };

  const existing = read();
  if (existing) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows has no POSIX mode bits.
    }
    return existing;
  }

  const token = randomBytes(32).toString('hex');
  try {
    // wx: if a concurrent writer won the race, re-read their token instead.
    writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = read();
      if (raced) return raced;
      // The existing file is corrupt (too short): replace it atomically enough
      // for a single-instance desktop app, then enforce the mode bits.
      writeFileSync(path, `${token}\n`, { mode: 0o600 });
    } else {
      throw new Error(`could not create the server token: ${errorText(err)}`);
    }
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows.
  }
  return token;
}

/** First usable non-internal IPv4 address; null when the machine has none. */
export function pickLanIpv4(): string | null {
  const interfaces = networkInterfaces();
  const candidates: { address: string; rank: number; index: number }[] = [];
  let index = 0;
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      index += 1;
      if (info.internal) continue;
      if (info.family !== 'IPv4') continue;
      if (info.address.startsWith('169.254.')) continue;
      candidates.push({
        address: info.address,
        rank: lanRank(name, info.address),
        index,
      });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return candidates[0]?.address ?? null;
}

/** Lower is better. Physical/private LAN first, Docker/Tailscale-style last. */
function lanRank(name: string, address: string): number {
  const octets = /^(\d{1,3})\.(\d{1,3})\./.exec(address);
  const [first, second] = octets ? [Number(octets[1]), Number(octets[2])] : [0, 0];
  if (first === 172 && second >= 16 && second <= 31) return 3; // Docker bridge
  if (first === 100 && second >= 64 && second <= 127) return 2; // CGNAT/Tailscale
  if (/^(docker|br-|veth|virbr|vmnet|utun|tun|tap)/i.test(name)) return 3;
  if (first === 10 || first === 192 || (first === 172 && second < 32)) return 0;
  return 1;
}

/** True when nothing is listening on the fixed port (both wildcard and loopback checked). */
export function isPortAvailable(port: number, host: string = SERVER_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

export interface ServerManagerOptions {
  userData: string;
  token: string;
  resources: ResourcePaths;
  onUnexpectedExit(reason: string): void;
}

/**
 * Owns exactly one Fastify child. Every start opens a fresh log stream; stop
 * is idempotent and escalates SIGTERM -> SIGKILL after five seconds. On
 * Windows the whole process tree is removed with taskkill because yt-dlp and
 * ffmpeg are grandchildren of the server.
 */
export class ServerManager {
  private child: ChildProcess | null = null;
  private logger: RedactingLogWriter | null = null;
  private stopping = false;
  private generation = 0;

  constructor(private readonly options: ServerManagerOptions) {}

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Starts and waits for /health. Throws on spawn error, early exit or timeout. */
  async start(config: DesktopConfig, lanUrl: string | null): Promise<void> {
    if (this.child) throw new Error('the local server is already running');

    const generation = ++this.generation;
    this.stopping = false;
    this.logger = this.openLog();
    this.logger.write(
      Buffer.from(
        `[desktop] starting server pid-pending host=${config.lanEnabled ? '0.0.0.0' : SERVER_HOST} port=${SERVER_PORT}\n`,
      ),
    );

    const proc = spawn(process.execPath, [join(this.options.resources.serverDir, 'main.mjs')], {
      cwd: this.options.resources.serverDir,
      env: buildServerEnv(this.options, config, lanUrl),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = proc;

    let spawnError: Error | null = null;
    proc.once('error', (err) => {
      spawnError = err;
      this.logger?.write(Buffer.from(`[desktop] server spawn failed: ${errorText(err)}\n`));
    });
    proc.stdout?.on('data', (chunk: Buffer) => this.logger?.write(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => this.logger?.write(chunk));
    proc.once('exit', (code, signal) => {
      const wasCurrent = this.child === proc;
      if (wasCurrent) this.child = null;
      this.closeLog();

      if (!wasCurrent || this.stopping || this.generation !== generation) return;
      this.options.onUnexpectedExit(
        `The local server stopped unexpectedly (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`,
      );
    });

    try {
      await waitForHealth(() => spawnError, proc);
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /** Attempts startup up to `attempts` times with a short backoff between tries. */
  async startWithRetries(config: DesktopConfig, lanUrl: string | null, attempts = 3): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.start(config, lanUrl);
        return;
      } catch (err) {
        last = err;
        await this.stop();
        if (attempt < attempts - 1) await delay(400 * (attempt + 1));
      }
    }
    throw last instanceof Error ? last : new Error('the local server did not start');
  }

  /** Graceful stop with a hard-stop backstop. Safe to call repeatedly. */
  async stop(): Promise<void> {
    const proc = this.child;
    this.stopping = true;
    this.generation += 1;
    this.child = null;

    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      this.closeLog();
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        finish();
      }, STOP_GRACE_MS);

      proc.once('exit', finish);

      if (process.platform === 'win32') {
        const pid = proc.pid;
        if (pid === undefined) {
          finish();
          return;
        }
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('error', () => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        });
      } else {
        try {
          proc.kill('SIGTERM');
        } catch {
          finish();
        }
      }
    });

    this.closeLog();
  }

  /** Synchronous last resort for process exit: no waiting, no streams. */
  forceKill(): void {
    const proc = this.child;
    this.child = null;
    this.stopping = true;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    if (process.platform === 'win32' && proc.pid !== undefined) {
      try {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        // Fall through to kill().
      }
    }
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  private openLog(): RedactingLogWriter {
    const logDir = join(this.options.userData, 'logs');
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const path = join(logDir, 'server.log');
    const stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
    stream.once('open', () => {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Windows.
      }
    });
    stream.on('error', (err) => {
      console.error(`[desktop] could not write ${path}: ${errorText(err)}`);
    });
    return new RedactingLogWriter(this.options.token, stream);
  }

  private closeLog(): void {
    this.logger?.close();
    this.logger = null;
  }
}

/**
 * Builds the child environment. Values that are not configured are set to
 * undefined so an inherited shell variable cannot silently enable Supabase,
 * LAN or cast in the packaged app.
 */
function buildServerEnv(
  options: ServerManagerOptions,
  config: DesktopConfig,
  lanUrl: string | null,
): NodeJS.ProcessEnv {
  const parentPath = process.env['PATH'] ?? '';
  const lanEnabled = config.lanEnabled && lanUrl !== null;
  const cors = new Set([
    SERVER_ORIGIN,
    'capacitor://localhost',
    'http://localhost',
    ...(lanEnabled ? [lanUrl] : []),
  ]);
  const binary = (name: string): string =>
    process.platform === 'win32' ? `${name}.exe` : name;

  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HOST: lanEnabled ? '0.0.0.0' : SERVER_HOST,
    PORT: String(SERVER_PORT),
    WEB_DIR: options.resources.webDir,
    OPEN_RECORD_DATA_DIR: join(options.userData, 'server'),
    OPEN_RECORD_TOKEN: options.token,
    OPEN_RECORD_QUIET_STARTUP: '1',
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_ANON_KEY: config.supabaseAnonKey,
    SUPABASE_JWT_SECRET: config.jwtSecret,
    PUBLIC_URL: lanEnabled ? lanUrl : undefined,
    CAST_MEDIA_BASE_URL: lanEnabled ? lanUrl : undefined,
    CAST_ENABLED: lanEnabled ? 'true' : 'false',
    YTDLP_PATH: join(options.resources.binDir, binary('yt-dlp')),
    FFMPEG_PATH: join(options.resources.binDir, binary('ffmpeg')),
    YTDLP_JS_RUNTIME: `node:${process.execPath}`,
    PATH: [options.resources.binDir, parentPath].filter(Boolean).join(delimiter),
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    TRUST_PROXY: 'false',
    CORS_ORIGINS: [...cors].join(','),
  };
}

/** Polls the unauthenticated health endpoint until the server is ready. */
async function waitForHealth(
  spawnError: () => Error | null,
  proc: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const failed = spawnError();
    if (failed) throw new Error(`the local server could not be spawned: ${failed.message}`);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `the local server exited during startup (code ${proc.exitCode}, signal ${proc.signalCode ?? 'none'})`,
      );
    }
    try {
      const res = await fetch(`${SERVER_ORIGIN}/health`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(1_500),
      });
      if (res.ok) {
        const body: unknown = await res.json();
        if (isRecord(body) && body['status'] === 'ok') return;
      }
    } catch {
      // Not listening yet; keep polling.
    }
    await delay(HEALTH_POLL_MS);
  }
  throw new Error(`the local server did not answer /health within ${HEALTH_TIMEOUT_MS / 1_000}s`);
}

/**
 * Writes child output to a mode-0600 log, redacting the token across chunk
 * boundaries (a token split over two stdout reads must not leak).
 */
class RedactingLogWriter {
  private pending = '';
  private line = '';
  private closed = false;

  constructor(
    private readonly token: string,
    private readonly stream: WriteStream,
  ) {}

  write(chunk: Buffer | string): void {
    if (this.closed) return;
    let text = this.pending + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    if (this.token) text = text.split(this.token).join('[token]');

    // Hold a suffix that could be the start of a token split across chunks.
    const hold = partialTokenSuffix(text, this.token);
    this.pending = text.slice(text.length - hold);
    this.line += text.slice(0, text.length - hold);

    let newline = this.line.indexOf('\n');
    while (newline !== -1) {
      this.emitLine(this.line.slice(0, newline));
      this.line = this.line.slice(newline + 1);
      newline = this.line.indexOf('\n');
    }
    if (this.line.length > MAX_LOG_LINE) {
      this.emitLine(this.line);
      this.line = '';
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const tail = (this.pending + this.line).split(this.token).join('[token]');
    this.pending = '';
    this.line = '';
    if (tail) this.emitLine(tail);
    this.stream.end();
  }

  private emitLine(line: string): void {
    const text = line.replace(/\r$/, '');
    if (!text) return;
    // The quiet-startup flag suppresses these too; kept as a second line of defence.
    if (/[█▀▄]/.test(text) || text.includes('Pairing:')) return;
    try {
      this.stream.write(`${text}\n`);
    } catch {
      // The stream errored/closed; disk logging is best-effort.
    }
  }
}

/** Length of the longest suffix of `text` that is a proper prefix of `token`. */
function partialTokenSuffix(text: string, token: string): number {
  if (!token) return 0;
  const max = Math.min(token.length - 1, text.length);
  for (let length = max; length > 0; length -= 1) {
    if (text.endsWith(token.slice(0, length))) return length;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
