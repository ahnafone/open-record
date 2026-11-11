import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  loadDesktopConfig,
  saveDesktopConfig,
  supabaseHost,
  validateSupabaseConfig,
  type DesktopConfig,
  type ValidatedSupabaseConfig,
} from './config';
import {
  createCspBuilder,
  installContentSecurityPolicy,
  isHttpsUrl,
  isLocalOrigin,
  lockPermissions,
} from './security';
import { canSelfUpdate, createDesktopUpdater } from './updater';
import {
  isPortAvailable,
  pickLanIpv4,
  readOrCreateToken,
  resolveResourcePaths,
  SERVER_HOST,
  SERVER_ORIGIN,
  SERVER_PORT,
  ServerManager,
  type ResourcePaths,
} from './server';
import {
  DESKTOP_CHANNELS,
  type ActionResult,
  type DesktopStatus,
  type ServerState,
} from './types';

const APP_TITLE = 'Open Record';
const GUIDE_URL = 'https://github.com/ahnafone/open-record/blob/main/docs/desktop.md';
const BUSY_ERROR = 'Another desktop operation is in progress. Try again in a moment.';
const RELOAD_DELAY_MS = 100;

// Test/profile isolation must happen before Electron touches userData.
app.setName(APP_TITLE);
const userDataOverride = process.env['OPEN_RECORD_DESKTOP_USER_DATA']?.trim();
if (userDataOverride) app.setPath('userData', resolve(userDataOverride));

let win: BrowserWindow | null = null;
let server: ServerManager | null = null;
let resources: ResourcePaths | null = null;
let config: DesktopConfig = { lanEnabled: false };
let token = '';
let lanUrl: string | null = null;
let state: { server: ServerState; error: string | null } = { server: 'starting', error: null };
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;
let actionBusy = false;
let recovering = false;
let reloadTimer: NodeJS.Timeout | null = null;
let allowDataNavigation = false;
let ipcRegistered = false;

const desktopUpdater = createDesktopUpdater({
  getWindow: () => win,
  prepareInstall: prepareUpdateInstall,
  resumeAfterFailedInstall: resumeAfterFailedUpdateInstall,
});

/** Stable loopback origin. Never changes: IndexedDB and localStorage are keyed by it. */
function currentStatus(): DesktopStatus {
  const activeLan = config.lanEnabled && state.server === 'ready' ? lanUrl : null;
  return {
    server: state.server,
    localUrl: SERVER_ORIGIN,
    lanEnabled: config.lanEnabled,
    lanUrl: activeLan,
    supabaseConfigured: Boolean(config.supabaseUrl && config.supabaseAnonKey),
    supabaseHost: supabaseHost(config),
    dataDir: app.getPath('userData'),
    version: app.getVersion(),
    canSelfUpdate: canSelfUpdate(),
    error: state.error,
  };
}

function setState(serverState: ServerState, error: string | null): void {
  state = { server: serverState, error };
}

function activeLanUrl(): string | null {
  return config.lanEnabled && state.server === 'ready' ? lanUrl : null;
}

/* -------------------------------------------------------------------------- */
/* Window and renderer security                                               */
/* -------------------------------------------------------------------------- */

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;

  const created = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: APP_TITLE,
    backgroundColor: '#171b20',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win = created;

  created.on('closed', () => {
    if (win === created) win = null;
  });

  created.once('ready-to-show', () => {
    if (quitting) return;
    if (created.isMinimized()) created.restore();
    created.show();
    created.focus();
  });

  created.webContents.on('will-navigate', (event, url) => {
    if (allowDataNavigation && url.startsWith('data:text/html')) return;
    if (!isLocalOrigin(url)) event.preventDefault();
  });
  created.webContents.on('will-redirect', (event, url) => {
    if (!isLocalOrigin(url)) event.preventDefault();
  });
  created.webContents.setWindowOpenHandler(({ url }) => {
    // External links only: https, never the local origin, never file://.
    if (isHttpsUrl(url) && !isLocalOrigin(url)) {
      void shell.openExternal(url).catch((err: unknown) => {
        console.error(`[desktop] could not open external link: ${errorText(err)}`);
      });
    }
    return { action: 'deny' };
  });
  created.webContents.on('will-attach-webview', (event) => event.preventDefault());

  return created;
}

async function loadApp(): Promise<void> {
  const window = ensureWindow();
  allowDataNavigation = false;
  // Keep the screen the user was on (e.g. /desktop) when a config change
  // restarts the server; a reload must not dump them back on Browse.
  const current = window.webContents.getURL();
  const target = current && isLocalOrigin(current) ? current : `${SERVER_ORIGIN}/`;
  await window.loadURL(target);
}

/** Shows a real error document instead of Chromium's blank/offline page. */
async function showErrorPage(message: string): Promise<void> {
  const window = ensureWindow();
  allowDataNavigation = true;
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorPageHtml(message))}`);
  } catch (err) {
    console.error(`[desktop] could not show the error page: ${errorText(err)}`);
  } finally {
    allowDataNavigation = false;
  }
  if (!window.isVisible() && !window.isMinimized() && !quitting) window.show();
}

function errorPageHtml(message: string): string {
  const logs = join(app.getPath('userData'), 'logs');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP_TITLE}</title>
<style>
:root { color-scheme: dark; }
html, body { height: 100%; margin: 0; }
body {
  display: grid; place-items: center; padding: 32px;
  background: #171b20; color: #f5f0e6;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 620px; }
h1 { margin: 0 0 12px; font-family: Georgia, "Times New Roman", serif; font-size: 28px; font-weight: 400; }
p { margin: 0 0 14px; line-height: 1.55; color: #bcc4cb; }
pre {
  overflow-wrap: anywhere; white-space: pre-wrap; margin: 18px 0;
  padding: 14px 16px; border: 1px solid #56616c; border-radius: 8px;
  background: #252c33; color: #ffb4ad; font-size: 13px; line-height: 1.5;
}
code { color: #f5f0e6; }
</style>
</head>
<body>
<main>
  <h1>Open Record can't start its local server</h1>
  <p>The UI is served by a local Fastify process on <code>${SERVER_ORIGIN}</code>. It did not become healthy, so the app is not going to show a blank window.</p>
  <pre>${escapeHtml(message)}</pre>
  <p>Logs are in <code>${escapeHtml(logs)}</code>. Use <strong>Retry</strong>, <strong>Open logs folder</strong>, or <strong>Quit</strong> in the dialog.</p>
</main>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Server lifecycle                                                           */
/* -------------------------------------------------------------------------- */

async function startServer(): Promise<void> {
  if (!resources) throw new Error('desktop resources are not resolved');
  assertResources(resources);

  setState('starting', null);
  lanUrl = null;

  const lanIp = config.lanEnabled ? pickLanIpv4() : null;
  if (config.lanEnabled && !lanIp) {
    throw new Error(
      'LAN mode is enabled, but this computer has no non-internal IPv4 address. Connect to Wi-Fi/Ethernet and try again.',
    );
  }
  const nextLanUrl = lanIp ? `http://${lanIp}:${SERVER_PORT}` : null;
  const bindHost = config.lanEnabled ? '0.0.0.0' : SERVER_HOST;
  if (!(await isPortAvailable(SERVER_PORT, bindHost))) {
    throw new Error(
      `Port ${SERVER_PORT} is already in use on ${bindHost}. Close the program using it and retry. Open Record never changes its loopback origin silently.`,
    );
  }

  const manager = new ServerManager({
    userData: app.getPath('userData'),
    token,
    resources,
    onUnexpectedExit: handleUnexpectedExit,
  });
  server = manager;
  await manager.startWithRetries(config, nextLanUrl);
  lanUrl = nextLanUrl;
}

async function stopServer(): Promise<void> {
  // A pending reload from the previous action must not race the next restart:
  // it would hit a deliberately-stopped server and show the error page.
  cancelScheduledReload();
  const current = server;
  server = null;
  await current?.stop();
}

/** Initial start + immediate load: there is no renderer to report to yet. */
async function startAndLoad(): Promise<void> {
  await stopServer();
  await startServer();
  setState('ready', null);
  try {
    await loadApp();
  } catch (err) {
    const message = errorText(err);
    setState('error', message);
    await stopServer();
    throw err;
  }
}

/** IPC-driven restart: return the new status first, then reload the renderer. */
async function restartForIpc(): Promise<ActionResult> {
  setState('starting', null);
  try {
    await stopServer();
    await startServer();
    setState('ready', null);
    scheduleReload();
    return { ok: true, status: currentStatus() };
  } catch (err) {
    const message = errorText(err);
    setState('error', message);
    await stopServer();
    return { ok: false, error: message };
  }
}

function scheduleReload(): void {
  cancelScheduledReload();
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (quitting || !win || win.isDestroyed()) return;
    void loadApp().catch((err: unknown) => {
      const message = errorText(err);
      setState('error', message);
      void recoveryLoop(message);
    });
  }, RELOAD_DELAY_MS);
}

function cancelScheduledReload(): void {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

function handleUnexpectedExit(reason: string): void {
  if (quitting || actionBusy) return;
  console.error(`[desktop] ${reason}`);
  setState('error', reason);
  void recoveryLoop(reason).catch((err: unknown) => {
    console.error(`[desktop] recovery failed: ${errorText(err)}`);
    quitting = true;
    dialog.showErrorBox(APP_TITLE, `The local server failed and recovery could not continue.\n\n${reason}`);
    app.quit();
  });
}

/* -------------------------------------------------------------------------- */
/* Failure dialog + retry loop                                                */
/* -------------------------------------------------------------------------- */

async function recoveryLoop(initialMessage: string): Promise<void> {
  if (recovering || quitting) return;
  recovering = true;
  let message = initialMessage;

  try {
    for (;;) {
      setState('error', message);
      await showErrorPage(message);
      const choice = await showFailureDialog(message);

      if (choice === 'quit') {
        quitting = true;
        app.quit();
        return;
      }
      if (choice === 'logs') {
        await openLogsFolder();
        continue;
      }

      try {
        await startAndLoad();
        return;
      } catch (err) {
        message = errorText(err);
      }
    }
  } finally {
    recovering = false;
  }
}

async function showFailureDialog(message: string): Promise<'retry' | 'logs' | 'quit'> {
  const options: MessageBoxOptions = {
    type: 'error',
    title: APP_TITLE,
    message: 'Open Record could not start its local server.',
    detail: `${message}\n\nLogs: ${join(app.getPath('userData'), 'logs')}`,
    buttons: ['Retry', 'Open logs folder', 'Quit'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };

  const owner = win && !win.isDestroyed() ? win : null;
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  if (result.response === 1) return 'logs';
  if (result.response === 2) return 'quit';
  return 'retry';
}

async function openLogsFolder(): Promise<void> {
  const dir = join(app.getPath('userData'), 'logs');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const failure = await shell.openPath(dir);
    if (failure) console.error(`[desktop] could not open logs: ${failure}`);
  } catch (err) {
    console.error(`[desktop] could not open logs: ${errorText(err)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

async function runExclusive<T>(fallback: T, work: () => Promise<T>): Promise<T> {
  if (actionBusy) return fallback;
  actionBusy = true;
  try {
    return await work();
  } finally {
    actionBusy = false;
  }
}

async function saveSupabaseConfigAction(input: unknown): Promise<ActionResult> {
  let validated: ValidatedSupabaseConfig;
  try {
    validated = validateSupabaseConfig(input);
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }

  return runExclusive<ActionResult>({ ok: false, error: BUSY_ERROR }, async () => {
    const next: DesktopConfig = {
      ...config,
      supabaseUrl: validated.supabaseUrl,
      supabaseAnonKey: validated.supabaseAnonKey,
    };
    if (validated.jwtSecret === undefined) delete next.jwtSecret;
    else next.jwtSecret = validated.jwtSecret;
    return applyConfig(next);
  });
}

async function setLanEnabledAction(enabled: unknown): Promise<ActionResult> {
  if (typeof enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean.' };
  }
  if (enabled && !pickLanIpv4()) {
    return {
      ok: false,
      error:
        'Cannot enable LAN mode: this computer has no non-internal IPv4 address. Connect to Wi-Fi/Ethernet and try again.',
    };
  }

  return runExclusive<ActionResult>({ ok: false, error: BUSY_ERROR }, async () =>
    applyConfig({ ...config, lanEnabled: enabled }),
  );
}

/**
 * Persist and apply a config change. The renderer keeps its origin and data;
 * only the Fastify child restarts. A failed rollout is rolled back so a LAN
 * toggle cannot strand the user on a broken server with no setup page.
 */
async function applyConfig(next: DesktopConfig): Promise<ActionResult> {
  const previous = config;
  try {
    saveDesktopConfig(app.getPath('userData'), next);
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }

  config = next;
  const result = await restartForIpc();
  if (result.ok) return result;

  try {
    saveDesktopConfig(app.getPath('userData'), previous);
    config = previous;
    const rollback = await restartForIpc();
    if (rollback.ok) {
      return { ok: false, error: `${result.error} The previous settings were restored.` };
    }
    return {
      ok: false,
      error: `${result.error} Restoring the previous settings also failed: ${rollback.error}`,
    };
  } catch (rollbackErr) {
    return {
      ok: false,
      error: `${result.error} Restoring the previous settings also failed: ${errorText(rollbackErr)}`,
    };
  }
}

async function restartServerAction(): Promise<ActionResult> {
  return runExclusive<ActionResult>({ ok: false, error: BUSY_ERROR }, async () => restartForIpc());
}

/* -------------------------------------------------------------------------- */
/* Auto-update                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Runs before the update installer starts: the installer must never race the
 * bundled server's files or process. Like a quit, this stops the server; the
 * before-quit handler then sees no server and lets the app exit.
 */
async function prepareUpdateInstall(): Promise<void> {
  if (actionBusy) throw new Error(BUSY_ERROR);
  quitting = true;
  cancelScheduledReload();
  try {
    await stopServer();
  } catch (err) {
    console.error(`[desktop] server shutdown before update failed: ${errorText(err)}`);
  }
}

/** The installer did not start: bring the local server back so the app stays usable. */
async function resumeAfterFailedUpdateInstall(): Promise<void> {
  quitting = false;
  const result = await restartForIpc();
  if (!result.ok) console.error(`[desktop] could not restart the server: ${result.error}`);
}

/* -------------------------------------------------------------------------- */
/* IPC                                                                        */
/* -------------------------------------------------------------------------- */

function registerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  handle(DESKTOP_CHANNELS.getStatus, () => currentStatus());
  handle(DESKTOP_CHANNELS.getConnection, () => {
    if (!token) throw new Error('The local server is not ready.');
    return { url: SERVER_ORIGIN, token };
  });
  handle(DESKTOP_CHANNELS.saveSupabaseConfig, (input) => saveSupabaseConfigAction(input));
  handle(DESKTOP_CHANNELS.setLanEnabled, (enabled) => setLanEnabledAction(enabled));
  handle(DESKTOP_CHANNELS.restartServer, () => restartServerAction());
  handle(DESKTOP_CHANNELS.getPairing, () => ({ lanUrl: activeLanUrl() }));
  handle(DESKTOP_CHANNELS.openGuide, async () => {
    await shell.openExternal(GUIDE_URL);
  });
  handle(DESKTOP_CHANNELS.openDataFolder, async () => {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const failure = await shell.openPath(dir);
    if (failure) throw new Error(`could not open the data folder: ${failure}`);
  });
  handle(DESKTOP_CHANNELS.updatesSupported, () => desktopUpdater.supported());
  handle(DESKTOP_CHANNELS.updatesDownload, () => desktopUpdater.download());
  handle(DESKTOP_CHANNELS.updatesInstall, () => desktopUpdater.install());
  handle(DESKTOP_CHANNELS.updatesInstallError, () => desktopUpdater.installError());
}

type IpcHandler = (...args: unknown[]) => unknown;

function handle(channel: string, handler: IpcHandler): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    assertTrustedSender(event);
    return handler(...args);
  });
}

/** Only the top frame of our own window, loaded from the fixed loopback origin. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const window = win;
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error('Untrusted IPC sender.');
  }
  const frame = event.senderFrame;
  if (!frame) throw new Error('Untrusted IPC sender.');
  try {
    if (frame.parent !== null || !isLocalOrigin(frame.url)) {
      throw new Error('Untrusted IPC sender.');
    }
  } catch {
    throw new Error('Untrusted IPC sender.');
  }
}

/* -------------------------------------------------------------------------- */
/* Boot / shutdown                                                            */
/* -------------------------------------------------------------------------- */

async function boot(): Promise<void> {
  try {
    resources = resolveResourcePaths(app.isPackaged, process.resourcesPath, __dirname);
    const userData = app.getPath('userData');
    mkdirSync(join(userData, 'server'), { recursive: true, mode: 0o700 });
    mkdirSync(join(userData, 'logs'), { recursive: true, mode: 0o700 });

    config = loadDesktopConfig(userData);
    token = readOrCreateToken(join(userData, 'server'));

    lockPermissions(session.defaultSession);
    const csp = createCspBuilder(
      () => config,
      () => activeLanUrl(),
      resources.webDir,
    );
    installContentSecurityPolicy(csp);
    registerIpc();

    await startAndLoad();
  } catch (err) {
    const message = errorText(err);
    console.error(`[desktop] boot failed: ${message}`);
    setState('error', message);
    await recoveryLoop(message);
  }
}

function assertResources(paths: ResourcePaths): void {
  if (!existsSync(join(paths.serverDir, 'main.mjs'))) {
    throw new Error(
      `The bundled local server is missing (${join(paths.serverDir, 'main.mjs')}). Reinstall Open Record.`,
    );
  }
  if (!existsSync(join(paths.webDir, 'index.html'))) {
    throw new Error(
      `The bundled web app is missing (${join(paths.webDir, 'index.html')}). Reinstall Open Record.`,
    );
  }
}

function focusWindow(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function onBeforeQuit(event: Electron.Event): void {
  if (shutdownComplete) return;
  if (shutdownStarted) {
    event.preventDefault();
    return;
  }
  if (!server) {
    shutdownComplete = true;
    return;
  }

  event.preventDefault();
  shutdownStarted = true;
  quitting = true;
  cancelScheduledReload();
  void stopServer()
    .catch((err: unknown) => console.error(`[desktop] server shutdown failed: ${errorText(err)}`))
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/* -------------------------------------------------------------------------- */
/* App events                                                                 */
/* -------------------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  // A second launch focuses the existing window instead of racing for port 47900.
  app.quit();
} else {
  app.on('second-instance', () => focusWindow());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', onBeforeQuit);
  process.on('exit', () => server?.forceKill());

  void app
    .whenReady()
    .then(boot)
    .catch((err: unknown) => {
      const message = errorText(err);
      console.error(`[desktop] fatal boot failure: ${message}`);
      quitting = true;
      dialog.showErrorBox(APP_TITLE, `Open Record could not start.\n\n${message}`);
      app.quit();
    });
}
