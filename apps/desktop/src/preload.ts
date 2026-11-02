import { contextBridge, ipcRenderer } from 'electron';
import {
  DESKTOP_CHANNELS,
  type ActionResult,
  type DesktopBridge,
  type DesktopStatus,
  type SupabaseConfigInput,
} from './types';

/**
 * Sandboxed preload: only `electron` is available here, no Node built-ins.
 * Everything is invoked through validated main-process handlers; the renderer
 * never receives `ipcRenderer` itself.
 */
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

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
};

contextBridge.exposeInMainWorld('openRecordDesktop', Object.freeze(bridge));
