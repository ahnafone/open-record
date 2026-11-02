import {
  NOW_PLAYING_DEFAULT_WIDTH,
  NOW_PLAYING_MAX_WIDTH,
  NOW_PLAYING_MIN_WIDTH,
  clampNowPlayingPanelWidth,
  maxNowPlayingPanelWidth,
  readNowPlayingPanelOpen,
  readNowPlayingPanelWidth,
  writeNowPlayingPanelOpen,
  writeNowPlayingPanelWidth,
} from './panel-prefs';

const OPEN_KEY = 'or.nowPlaying.open';
const WIDTH_KEY = 'or.nowPlaying.width';

describe('panel prefs', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to closed and the default width', () => {
    expect(readNowPlayingPanelOpen()).toBe(false);
    expect(readNowPlayingPanelWidth(1440)).toBe(NOW_PLAYING_DEFAULT_WIDTH);
  });

  it('round-trips the open flag and the width', () => {
    writeNowPlayingPanelOpen(true);
    expect(readNowPlayingPanelOpen()).toBe(true);
    writeNowPlayingPanelOpen(false);
    expect(readNowPlayingPanelOpen()).toBe(false);

    writeNowPlayingPanelWidth(420);
    expect(localStorage.getItem(WIDTH_KEY)).toBe('420');
    expect(readNowPlayingPanelWidth(1440)).toBe(420);
  });

  it('ignores corrupt stored values', () => {
    localStorage.setItem(WIDTH_KEY, 'wide');
    expect(readNowPlayingPanelWidth(1440)).toBe(NOW_PLAYING_DEFAULT_WIDTH);

    localStorage.setItem(WIDTH_KEY, '');
    expect(readNowPlayingPanelWidth(1440)).toBe(NOW_PLAYING_DEFAULT_WIDTH);

    localStorage.setItem(OPEN_KEY, 'yes');
    expect(readNowPlayingPanelOpen()).toBe(false);
    localStorage.setItem(OPEN_KEY, '0');
    expect(readNowPlayingPanelOpen()).toBe(false);
    localStorage.setItem(OPEN_KEY, '1');
    expect(readNowPlayingPanelOpen()).toBe(true);
  });

  it('clamps widths to the allowed range', () => {
    expect(clampNowPlayingPanelWidth(100, 1440)).toBe(NOW_PLAYING_MIN_WIDTH);
    expect(clampNowPlayingPanelWidth(9999, 1440)).toBe(NOW_PLAYING_MAX_WIDTH);

    localStorage.setItem(WIDTH_KEY, '200');
    expect(readNowPlayingPanelWidth(1440)).toBe(NOW_PLAYING_MIN_WIDTH);
    localStorage.setItem(WIDTH_KEY, '700');
    expect(readNowPlayingPanelWidth(1440)).toBe(NOW_PLAYING_MAX_WIDTH);

    writeNowPlayingPanelWidth(420.6);
    expect(readNowPlayingPanelWidth(1440)).toBe(421);
  });

  it('caps the width per viewport', () => {
    expect(maxNowPlayingPanelWidth(1440)).toBe(NOW_PLAYING_MAX_WIDTH);
    expect(maxNowPlayingPanelWidth(1000)).toBe(512);
    expect(maxNowPlayingPanelWidth(900)).toBe(412);
    expect(maxNowPlayingPanelWidth(700)).toBe(NOW_PLAYING_MIN_WIDTH);
    expect(maxNowPlayingPanelWidth(0)).toBe(NOW_PLAYING_MAX_WIDTH);
    expect(maxNowPlayingPanelWidth(Number.NaN)).toBe(NOW_PLAYING_MAX_WIDTH);
    expect(maxNowPlayingPanelWidth(-100)).toBe(NOW_PLAYING_MAX_WIDTH);

    // A remembered wide panel shrinks to fit a smaller viewport on read.
    localStorage.setItem(WIDTH_KEY, '600');
    expect(readNowPlayingPanelWidth(900)).toBe(412);
    expect(readNowPlayingPanelWidth(700)).toBe(NOW_PLAYING_MIN_WIDTH);
  });

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(() => readNowPlayingPanelOpen()).not.toThrow();
    expect(readNowPlayingPanelOpen()).toBe(false);
    expect(() => readNowPlayingPanelWidth(1440)).not.toThrow();
    expect(readNowPlayingPanelWidth(1440)).toBe(NOW_PLAYING_DEFAULT_WIDTH);
    expect(() => writeNowPlayingPanelOpen(true)).not.toThrow();
    expect(() => writeNowPlayingPanelWidth(420)).not.toThrow();
  });
});
