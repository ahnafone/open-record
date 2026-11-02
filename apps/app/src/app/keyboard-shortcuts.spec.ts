import { mediaKeyAction, pageKeyAction } from './keyboard-shortcuts';

describe('mediaKeyAction', () => {
  it('maps PC media keys to playback commands', () => {
    const table: ReadonlyArray<[string, ReturnType<typeof mediaKeyAction>]> = [
      ['MediaPlay', 'play'],
      ['MediaPause', 'pause'],
      ['MediaPlayPause', 'toggle'],
      ['MediaTrackNext', 'next'],
      ['MediaTrackPrevious', 'previous'],
    ];
    for (const [key, action] of table) {
      expect(mediaKeyAction(key)).toBe(action);
    }
  });

  it('keeps separate play and pause keys distinct from toggle', () => {
    expect(mediaKeyAction('MediaPlay')).toBe('play');
    expect(mediaKeyAction('MediaPause')).toBe('pause');
  });

  it('ignores typing and navigation keys', () => {
    for (const key of [
      ' ',
      'ArrowLeft',
      'ArrowRight',
      'PageUp',
      'PageDown',
      'Enter',
    ]) {
      expect(mediaKeyAction(key)).toBeNull();
    }
  });
});

describe('pageKeyAction', () => {
  it('maps PageDown to next and PageUp to previous', () => {
    expect(pageKeyAction('PageDown')).toBe('next');
    expect(pageKeyAction('PageUp')).toBe('previous');
  });

  it('ignores typing, arrow and media keys', () => {
    for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'MediaPlay', 'Enter']) {
      expect(pageKeyAction(key)).toBeNull();
    }
  });
});
