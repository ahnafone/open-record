// Electron main process (feasibility spike): spawns the bundled Fastify server
// as a child (Electron in Node mode), waits for /health and loads the web app
// it serves on a fixed loopback origin. No preload/IPC yet.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { BrowserWindow, app, dialog, session, shell } from 'electron';

const HOST = '127.0.0.1';
const PORT = 47900;
const ORIGIN = `http://${HOST}:${PORT}`;
const HEALTH_POLL_MS = 150;
const HEALTH_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;

/** Packaged: extraResources. Dev: the workspace dist folders. */
function resourcePaths(): { serverDir: string; webDir: string; binDir: string } {
  if (app.isPackaged) {
    return {
      serverDir: join(process.resourcesPath, 'server'),
      webDir: join(process.resourcesPath, 'app', 'browser'),
      binDir: join(process.resourcesPath, 'bin'),
    };
  }
  // dist/apps/desktop/main/main.cjs -> workspace root
  const root = resolve(__dirname, '../../../..');
  return {
    serverDir: join(root, 'dist/apps/desktop/server'),
    webDir: join(root, 'dist/apps/app/browser'),
    binDir: join(root, 'dist/apps/desktop/bin'),
  };
}

/**
 * Same file the server would use (`<dataDir>/token`, 0600), created here so
 * the main process knows the token without parsing server output, and can
 * redact it from logs and hand it to the window later.
 */
function readOrCreateToken(dataDir: string): string {
  const path = join(dataDir, 'token');
  try {
    const stored = readFileSync(path, 'utf8').trim();
    if (stored.length >= 16) return stored;
  } catch {
    // missing: generate below
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, host);
  });
}

let child: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

function startServer(token: string): ChildProcess {
  const { serverDir, webDir, binDir } = resourcePaths();
  const userData = app.getPath('userData');
  const logDir = join(userData, 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = createWriteStream(join(logDir, 'server.log'), { flags: 'a', mode: 0o600 });

  const proc = spawn(process.execPath, [join(serverDir, 'main.mjs')], {
    cwd: serverDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST,
      PORT: String(PORT),
      WEB_DIR: webDir,
      OPEN_RECORD_DATA_DIR: join(userData, 'server'),
      OPEN_RECORD_TOKEN: token,
      YTDLP_PATH: join(binDir, 'yt-dlp'),
      FFMPEG_PATH: join(binDir, 'ffmpeg'),
      YTDLP_JS_RUNTIME: `node:${process.execPath}`,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      TRUST_PROXY: 'false',
      CORS_ORIGINS: ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // The startup banner prints the token and a QR of it: redact before logging.
  const write = (chunk: Buffer): void => {
    const text = chunk.toString('utf8').split(token).join('[token]');
    for (const line of text.split('\n')) {
      if (/[█▀▄]/.test(line) || line.includes('Pairing:')) continue;
      if (line) log.write(`${line}\n`);
    }
  };
  proc.stdout?.on('data', write);
  proc.stderr?.on('data', write);
  proc.once('exit', (code, signal) => {
    log.write(`[desktop] server exited code=${code} signal=${signal}\n`);
    log.end();
    if (child === proc) child = null;
    if (!quitting) {
      dialog.showErrorBox('Open Record', `The local server stopped (code ${code}, signal ${signal}).`);
      app.quit();
    }
  });
  return proc;
}

async function waitForHealth(proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error('server exited during startup');
    try {
      const res = await fetch(`${ORIGIN}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`server did not answer ${ORIGIN}/health within ${HEALTH_TIMEOUT_MS / 1000}s`);
}

/** SIGTERM, then SIGKILL after the grace period. */
function stopServer(): Promise<void> {
  const proc = child;
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), STOP_GRACE_MS);
    proc.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    proc.kill('SIGTERM');
  });
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 900,
    backgroundColor: '#171b20',
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  w.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== ORIGIN) event.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.once('ready-to-show', () => w.show());
  return w;
}

/** Spike-only: OPEN_RECORD_SPIKE_SCREENSHOT=<png> captures the window and quits. */
function spikeCapture(w: BrowserWindow): void {
  const out = process.env['OPEN_RECORD_SPIKE_SCREENSHOT'];
  if (!out) return;
  w.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const image = await w.webContents.capturePage();
      writeFileSync(out, image.toPNG());
      console.log(`[desktop] screenshot ${out} title=${JSON.stringify(w.getTitle())}`);
      app.quit();
    }, 3000);
  });
}

function fatal(message: string): void {
  console.error(`[desktop] ${message}`);
  dialog.showErrorBox('Open Record', message);
  app.exit(1);
}

async function boot(): Promise<void> {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  if (!(await portFree(PORT, HOST))) {
    fatal(`Port ${PORT} on ${HOST} is already in use. Close the program using it and start Open Record again.`);
    return;
  }

  const token = readOrCreateToken(join(app.getPath('userData'), 'server'));
  child = startServer(token);
  try {
    await waitForHealth(child);
  } catch (err) {
    quitting = true;
    await stopServer();
    fatal(`The local server failed to start: ${(err as Error).message}`);
    return;
  }
  console.log(`[desktop] server healthy at ${ORIGIN} (pid ${child.pid})`);

  win = createWindow();
  spikeCapture(win);
  await win.loadURL(`${ORIGIN}/`);
}

// Spike/testing: keep test runs out of the real profile.
const userDataOverride = process.env['OPEN_RECORD_DESKTOP_USER_DATA'];
app.setName('Open Record');
if (userDataOverride) app.setPath('userData', userDataOverride);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting || !child) return;
    event.preventDefault();
    quitting = true;
    void stopServer().then(() => app.quit());
  });
  process.on('exit', () => child?.kill('SIGKILL'));
  void app.whenReady().then(boot);
}
