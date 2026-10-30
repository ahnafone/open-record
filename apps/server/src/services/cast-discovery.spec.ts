import {
  CastDiscovery,
  toDiscoveredCast,
  type BonjourLike,
  type DiscoveredCast,
  type MdnsBrowser,
  type MdnsService,
} from './cast-discovery';

// ---------------------------------------------------------------------------
// Fakes: discovery must be testable without opening real mDNS sockets.
// ---------------------------------------------------------------------------

class FakeBrowser implements MdnsBrowser {
  readonly updates: string[] = [];
  stopCalls = 0;
  private onUp?: (service: MdnsService) => void;
  private onDown?: (service: MdnsService) => void;

  setOnUp(onUp?: (service: MdnsService) => void): void {
    this.onUp = onUp;
  }

  on(event: 'down', listener: (service: MdnsService) => void): this {
    if (event === 'down') this.onDown = listener;
    return this;
  }

  update(): void {
    this.updates.push('update');
  }

  stop(): void {
    this.stopCalls += 1;
  }

  up(service: MdnsService): void {
    this.onUp?.(service);
  }

  down(service: MdnsService): void {
    this.onDown?.(service);
  }
}

class FakeBonjour implements BonjourLike {
  readonly browser = new FakeBrowser();
  readonly findTypes: string[] = [];
  destroyCalls = 0;

  find(
    opts: { type: string },
    onup?: (service: MdnsService) => void,
  ): MdnsBrowser {
    this.findTypes.push(opts.type);
    this.browser.setOnUp(onup);
    return this.browser;
  }

  destroy(callback?: () => void): void {
    this.destroyCalls += 1;
    callback?.();
  }
}

function castService(
  opts: {
    id?: string;
    fn?: string;
    md?: string;
    addresses?: string[];
    host?: string;
    port?: number;
  } = {},
): MdnsService {
  const txt: Record<string, string> = { id: opts.id ?? 'cast-1' };
  if (opts.fn !== undefined) txt['fn'] = opts.fn;
  if (opts.md !== undefined) txt['md'] = opts.md;
  return {
    txt,
    addresses: opts.addresses ?? [],
    host: opts.host ?? 'cast-device.local',
    port: opts.port ?? 8009,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

describe('toDiscoveredCast', () => {
  it('maps the mDNS txt record into a device', () => {
    expect(
      toDiscoveredCast(
        { id: ' 192.168.1.20 ', fn: ' Living Room ', md: ' Chromecast ' },
        ' 192.168.1.20 ',
        8009,
      ),
    ).toEqual({
      castId: '192.168.1.20',
      name: 'Living Room',
      host: '192.168.1.20',
      port: 8009,
      model: 'Chromecast',
    });
  });

  it('falls back to the cast id and omits an empty model', () => {
    expect(toDiscoveredCast({ id: 'abc123' }, 'cast.local', 8009)).toEqual({
      castId: 'abc123',
      name: 'abc123',
      host: 'cast.local',
      port: 8009,
    });
  });

  it('returns null without an id, host or valid port', () => {
    expect(toDiscoveredCast({}, 'cast.local', 8009)).toBeNull();
    expect(toDiscoveredCast({ id: 'abc' }, '   ', 8009)).toBeNull();
    expect(toDiscoveredCast({ id: 'abc' }, 'cast.local', 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Discovery lifecycle
// ---------------------------------------------------------------------------

describe('CastDiscovery', () => {
  it('lists, dedupes and notifies on up/down', () => {
    const bonjour = new FakeBonjour();
    const discovery = new CastDiscovery({ bonjour });
    const changes: DiscoveredCast[][] = [];
    const unsubscribe = discovery.onChange((list) => {
      changes.push([...list]);
    });

    discovery.start();
    discovery.start(); // idempotent
    expect(bonjour.findTypes).toEqual(['googlecast']);

    const service = castService({
      id: 'cast-a',
      fn: 'Living Room',
      md: 'Chromecast',
      addresses: ['fe80::1', '192.168.1.20'],
      host: 'cast-a.local',
    });
    bonjour.browser.up(service);
    bonjour.browser.up(service); // same txt.id: no duplicate row or event

    expect(discovery.list()).toEqual([
      {
        castId: 'cast-a',
        name: 'Living Room',
        host: '192.168.1.20',
        port: 8009,
        model: 'Chromecast',
      },
    ]);
    expect(changes).toHaveLength(1);

    unsubscribe();
    bonjour.browser.down(service);
    expect(discovery.list()).toEqual([]);
    expect(changes).toHaveLength(1);

    bonjour.browser.up(service);
    expect(changes).toHaveLength(1);

    discovery.stop();
  });

  it('falls back to the service host without an IPv4 address', () => {
    const bonjour = new FakeBonjour();
    const discovery = new CastDiscovery({ bonjour });
    discovery.start();

    bonjour.browser.up(
      castService({ addresses: ['fe80::1'], host: 'cast-a.local' }),
    );

    expect(discovery.list()[0]?.host).toBe('cast-a.local');
    discovery.stop();
  });

  it('rescans on the interval and re-emits only on change', () => {
    vi.useFakeTimers();
    const bonjour = new FakeBonjour();
    const discovery = new CastDiscovery({ bonjour, intervalMs: 1_000 });
    const changes: number[] = [];
    discovery.onChange((list) => {
      changes.push(list.length);
    });

    discovery.start();
    vi.advanceTimersByTime(3_000);
    expect(bonjour.browser.updates).toHaveLength(3);
    expect(changes).toEqual([]);

    bonjour.browser.up(castService());
    expect(changes).toEqual([1]);

    vi.advanceTimersByTime(1_000);
    expect(bonjour.browser.updates).toHaveLength(4);
    expect(changes).toEqual([1]);

    discovery.stop();
  });

  it('stops idempotently and destroys Bonjour', () => {
    vi.useFakeTimers();
    const bonjour = new FakeBonjour();
    const discovery = new CastDiscovery({ bonjour, intervalMs: 1_000 });
    discovery.start();
    bonjour.browser.up(castService());

    discovery.stop();
    discovery.stop();

    expect(bonjour.destroyCalls).toBe(1);
    expect(bonjour.browser.stopCalls).toBe(1);
    expect(discovery.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays up with an empty list when discovery fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken: BonjourLike = {
      find() {
        throw new Error('no mdns');
      },
      destroy() {
        // The fake owns no sockets to release.
      },
    };
    const discovery = new CastDiscovery({ bonjour: broken });

    expect(() => discovery.start()).not.toThrow();
    expect(discovery.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    discovery.start();
    expect(warn).toHaveBeenCalledTimes(1);

    discovery.stop();
    warn.mockRestore();
  });
});
