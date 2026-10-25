import { Capacitor } from '@capacitor/core';
import { Network, type ConnectionStatus } from '@capacitor/network';
import { NetworkStatusPort, type NetworkState } from '@open-record/state';

function fromCapacitor(status: ConnectionStatus): NetworkState {
  return { connected: status.connected, connectionType: status.connectionType };
}

/** Native: the Capacitor Network plugin (Wi-Fi vs cellular from the OS). */
export class CapacitorNetworkStatus extends NetworkStatusPort {
  async current(): Promise<NetworkState> {
    return fromCapacitor(await Network.getStatus());
  }

  onChange(listener: (state: NetworkState) => void): () => void {
    const handle = Network.addListener('networkStatusChange', (s) => listener(fromCapacitor(s)));
    return () => void handle.then((h) => h.remove()).catch(() => undefined);
  }
}

interface NavigatorConnection extends EventTarget {
  type?: string;
}

/**
 * Web: `navigator.onLine` plus `navigator.connection.type` where the browser
 * has it. Browsers that cannot tell report `unknown` (treated as allowed).
 */
export class BrowserNetworkStatus extends NetworkStatusPort {
  private get connection(): NavigatorConnection | undefined {
    return (navigator as Navigator & { connection?: NavigatorConnection }).connection;
  }

  current(): Promise<NetworkState> {
    return Promise.resolve(this.read());
  }

  onChange(listener: (state: NetworkState) => void): () => void {
    const fire = () => listener(this.read());
    const connection = this.connection;
    window.addEventListener('online', fire);
    window.addEventListener('offline', fire);
    connection?.addEventListener('change', fire);
    return () => {
      window.removeEventListener('online', fire);
      window.removeEventListener('offline', fire);
      connection?.removeEventListener('change', fire);
    };
  }

  private read(): NetworkState {
    if (!navigator.onLine) return { connected: false, connectionType: 'none' };
    switch (this.connection?.type) {
      case 'wifi':
        return { connected: true, connectionType: 'wifi' };
      case 'ethernet':
        return { connected: true, connectionType: 'ethernet' };
      case 'cellular':
        return { connected: true, connectionType: 'cellular' };
      default:
        return { connected: true, connectionType: 'unknown' };
    }
  }
}

export function createNetworkStatus(): NetworkStatusPort {
  return Capacitor.isNativePlatform() ? new CapacitorNetworkStatus() : new BrowserNetworkStatus();
}
