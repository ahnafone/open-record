import type { Track } from '@open-record/models';
import { TabTitleController, formatTabTitle } from './tab-title';

const song = {
  id: '1',
  providerId: 'p',
  title: 'Song',
  artist: 'Artist',
} as Track;
const solo = { ...song, artist: '' };

/** Lets queued MutationObserver callbacks run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('formatTabTitle', () => {
  it('shows ▶ while playing or loading and ⏸ when paused', () => {
    expect(formatTabTitle(song, 'playing')).toBe(
      '▶ Song – Artist | Open Record',
    );
    expect(formatTabTitle(song, 'loading')).toBe(
      '▶ Song – Artist | Open Record',
    );
    expect(formatTabTitle(song, 'paused')).toBe(
      '⏸ Song – Artist | Open Record',
    );
    expect(formatTabTitle(song, 'error')).toBe('⏸ Song – Artist | Open Record');
  });

  it('omits the artist when it is empty', () => {
    expect(formatTabTitle(solo, 'playing')).toBe('▶ Song | Open Record');
  });

  it('returns null without a track, when idle or with a blank title', () => {
    expect(formatTabTitle(null, 'playing')).toBeNull();
    expect(formatTabTitle(song, 'idle')).toBeNull();
    expect(formatTabTitle({ ...solo, title: '  ' }, 'playing')).toBeNull();
  });
});

describe('TabTitleController', () => {
  it('sets the track title and restores the original on null', () => {
    document.title = 'Home';
    const tab = new TabTitleController(document);

    tab.update(song, 'playing');
    expect(document.title).toBe('▶ Song – Artist | Open Record');

    tab.update(null, 'idle');
    expect(document.title).toBe('Home');
    tab.destroy();
  });

  it('overrides a route title set while a track is shown', async () => {
    document.title = 'Home';
    const tab = new TabTitleController(document);
    tab.update(song, 'paused');

    document.title = 'Settings';
    await flush();
    expect(document.title).toBe('⏸ Song – Artist | Open Record');
    tab.destroy();
  });

  it('restores a route title that changed during playback', async () => {
    document.title = 'Home';
    const tab = new TabTitleController(document);
    tab.update(song, 'playing');

    document.title = 'Settings';
    await flush();
    tab.update(null, 'idle');
    expect(document.title).toBe('Settings');
    tab.destroy();
  });

  it('leaves later title changes alone after destroy', async () => {
    document.title = 'Home';
    const tab = new TabTitleController(document);
    tab.update(song, 'playing');
    tab.destroy();
    expect(document.title).toBe('Home');

    document.title = 'Later';
    await flush();
    expect(document.title).toBe('Later');
  });

  it('works again for a second track after restore', () => {
    document.title = 'Home';
    const tab = new TabTitleController(document);
    tab.update(song, 'playing');
    tab.update(null, 'idle');

    tab.update(solo, 'paused');
    expect(document.title).toBe('⏸ Song | Open Record');
    tab.update(null, 'idle');
    expect(document.title).toBe('Home');
    tab.destroy();
  });

  it('is a no-op without a document (SSR)', () => {
    const tab = new TabTitleController(null);
    expect(() => {
      tab.update(song, 'playing');
      tab.update(null, 'idle');
      tab.destroy();
    }).not.toThrow();
  });
});
