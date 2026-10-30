// Google Cast device discovery over mDNS (`_googlecast._tcp`). This module is
// deliberately small and transport-free: it only turns Bonjour service records
// into `DiscoveredCast` rows and keeps the last known list. The Cast service
// owns connections and media; discovery only answers "what is on the network?".
//
// Discovery is best-effort. A host without mDNS (or with a broken multicast
// socket) must still run the server, so `start()` never throws and leaves the
// list empty in that case.

import Bonjour from 'bonjour-service';
import { isIPv4 } from 'node:net';

export interface DiscoveredCast {
  castId: string;
  name: string;
  /** LAN IPv4 when available, otherwise the mDNS host name. */
  host: string;
  port: number;
  model?: string;
}

/** Minimal structural view of a `bonjour-service` service record. */
export interface MdnsService {
  readonly txt?: Record<string, unknown>;
  readonly addresses?: readonly string[];
  readonly host: string;
  readonly port: number;
}

/** Minimal structural view of a `bonjour-service` browser. */
export interface MdnsBrowser {
  on(event: 'down', listener: (service: MdnsService) => void): unknown;
  update(): void;
  stop?(): void;
}

/**
 * The slice of `bonjour-service` this module uses. Accepting a structural type
 * keeps the class testable with a fake and avoids opening real mDNS sockets.
 */
export interface BonjourLike {
  find(
    opts: { type: string },
    onup?: (service: MdnsService) => void,
  ): MdnsBrowser;
  destroy(callback?: () => void): void;
}

export type CastChangeListener = (list: readonly DiscoveredCast[]) => void;

/** Re-query mDNS periodically: `up`/`down` already cover most changes. */
const CAST_RESCAN_MS = 30_000;

function readTxt(
  txt: Record<string, string>,
  key: string,
): string | undefined {
  const value = txt[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Real service records are decoded from unknown bytes; keep only string fields. */
function toTxtRecord(value: Record<string, unknown> | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!value) return record;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') record[key] = raw;
  }
  return record;
}

/** Cast receivers advertise both an IPv6 and an IPv4 address; prefer IPv4. */
function preferredHost(service: MdnsService): string {
  const ipv4 = service.addresses?.find((address) => isIPv4(address));
  return ipv4 ?? service.host;
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

/**
 * Pure record mapping, exported for tests. Returns null when the record has no
 * usable identity (`txt.id`), host or port; a receiver without `txt.fn` falls
 * back to its id as the display name.
 */
export function toDiscoveredCast(
  txt: Record<string, string>,
  host: string,
  port: number,
): DiscoveredCast | null {
  const castId = readTxt(txt, 'id');
  const cleanHost = host.trim();
  if (!castId || !cleanHost || !isPort(port)) return null;

  const cast: DiscoveredCast = {
    castId,
    name: readTxt(txt, 'fn') ?? castId,
    host: cleanHost,
    port,
  };
  const model = readTxt(txt, 'md');
  if (model !== undefined) cast.model = model;
  return cast;
}

export class CastDiscovery {
  private readonly devices = new Map<string, DiscoveredCast>();
  private readonly listeners = new Set<CastChangeListener>();
  private readonly injectedBonjour?: BonjourLike;
  private readonly intervalMs: number;
  private bonjour: BonjourLike | null = null;
  private browser: MdnsBrowser | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private warned = false;
  private signature = '[]';

  constructor(opts: { bonjour?: BonjourLike; intervalMs?: number } = {}) {
    this.injectedBonjour = opts.bonjour;
    this.intervalMs = opts.intervalMs ?? CAST_RESCAN_MS;
  }

  /** Starts discovery. Idempotent; keeps the current list when already started. */
  start(): void {
    if (this.started) return;
    this.started = true;

    try {
      this.bonjour = this.injectedBonjour ?? new Bonjour();
      this.browser = this.bonjour.find({ type: 'googlecast' }, (service) => {
        this.handleUp(service);
      });
      this.browser.on('down', (service) => {
        this.handleDown(service);
      });

      if (Number.isFinite(this.intervalMs) && this.intervalMs > 0) {
        this.timer = setInterval(() => this.rescan(), this.intervalMs);
        this.timer.unref?.();
      }
    } catch (error) {
      // No multicast socket (or a transient bind failure): stay up with an
      // empty list. Log once; there is no injected logger in this class.
      this.browser = null;
      this.warnOnce(error);
    }
  }

  /** Stops discovery and destroys the Bonjour instance. Safe to call twice. */
  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const browser = this.browser;
    const bonjour = this.bonjour;
    this.browser = null;
    this.bonjour = null;
    this.devices.clear();
    this.signature = '[]';

    try {
      browser?.stop?.();
    } catch {
      // Already stopped by Bonjour.destroy() or a failed start.
    }
    try {
      bonjour?.destroy();
    } catch {
      // Destroying an already-destroyed instance is not an error for callers.
    }
  }

  list(): readonly DiscoveredCast[] {
    return this.snapshot();
  }

  onChange(listener: CastChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private handleUp(service: MdnsService): void {
    const cast = toDiscoveredCast(
      toTxtRecord(service.txt),
      preferredHost(service),
      service.port,
    );
    if (!cast) return;
    this.devices.set(cast.castId, cast);
    this.emitIfChanged();
  }

  private handleDown(service: MdnsService): void {
    const castId = readTxt(toTxtRecord(service.txt), 'id');
    if (!castId) return;
    if (this.devices.delete(castId)) this.emitIfChanged();
  }

  private rescan(): void {
    try {
      this.browser?.update();
    } catch (error) {
      this.warnOnce(error);
    }
    // `up`/`down` normally drive changes; this catches any list drift that the
    // browser does not surface as an event.
    this.emitIfChanged();
  }

  private emitIfChanged(): void {
    const list = this.snapshot();
    const signature = JSON.stringify(list);
    if (signature === this.signature) return;
    this.signature = signature;

    for (const listener of [...this.listeners]) {
      try {
        listener(list);
      } catch {
        // A throwing consumer must not break discovery for the other listeners.
      }
    }
  }

  /** Stable order so consumers see a deterministic device list. */
  private snapshot(): DiscoveredCast[] {
    return [...this.devices.values()]
      .map((cast) => ({ ...cast }))
      .sort((a, b) => a.castId.localeCompare(b.castId));
  }

  private warnOnce(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[cast] discovery unavailable (${message}); continuing without cast devices`,
    );
  }
}
