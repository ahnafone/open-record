import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  DESKTOP_CHANNELS,
  type ActionResult,
  type DesktopBridge,
  type DesktopStatus,
  type DesktopUpdatesBridge,
  type SupabaseConfigInput,
} from './types';

/**
 * Sandboxed preload: only `electron` is available here, no Node built-ins.
 * Everything is invoked through validated main-process handlers; the renderer
 * never receives `ipcRenderer` itself.
 */
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

/**
 * Subscribes to a main-to-renderer event. The listener is wrapped so the
 * renderer only ever sees the payload, never the IPC event object.
 */
function subscribe(channel: string, listener: (payload: unknown) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const updates: DesktopUpdatesBridge = {
  supported: () => invoke<boolean>(DESKTOP_CHANNELS.updatesSupported),
  download: () => invoke<void>(DESKTOP_CHANNELS.updatesDownload),
  install: () => invoke<void>(DESKTOP_CHANNELS.updatesInstall),
  installError: () => invoke<string | null>(DESKTOP_CHANNELS.updatesInstallError),
  onProgress: (listener: (fraction: number) => void) =>
    subscribe(DESKTOP_CHANNELS.updatesProgress, (payload) => {
      if (typeof payload === 'number' && Number.isFinite(payload)) {
        listener(Math.min(1, Math.max(0, payload)));
      }
    }),
  onDownloaded: (listener: () => void) =>
    subscribe(DESKTOP_CHANNELS.updatesDownloaded, () => listener()),
};

const bridge: DesktopBridge = {
  getStatus: () => invoke<DesktopStatus>(DESKTOP_CHANNELS.getStatus),
  getConnection: () =>
    invoke<{ url: string; token: string }>(DESKTOP_CHANNELS.getConnection),
  saveSupabaseConfig: (input: SupabaseConfigInput) =>
    invoke<ActionResult>(DESKTOP_CHANNELS.saveSupabaseConfig, input),
  setLanEnabled: (enabled: boolean) =>
    invoke<ActionResult>(DESKTOP_CHANNELS.setLanEnabled, enabled),
  restartServer: () => invoke<ActionResult>(DESKTOP_CHANNELS.restartServer),
  getPairing: () => invoke<{ lanUrl: string | null }>(DESKTOP_CHANNELS.getPairing),
  openGuide: () => invoke<void>(DESKTOP_CHANNELS.openGuide),
  openDataFolder: () => invoke<void>(DESKTOP_CHANNELS.openDataFolder),
  updates,
};

contextBridge.exposeInMainWorld('openRecordDesktop', Object.freeze(bridge));
