/**
 * Desktop keyboard shortcut mapping, kept free of Angular so it can be unit
 * tested as a plain table.
 */

/** Playback command for a PC media key. */
export type MediaKeyAction = 'play' | 'pause' | 'toggle' | 'next' | 'previous';

/** Queue navigation command for a page-navigation key. */
export type PageKeyAction = 'next' | 'previous';

/**
 * Maps a PC keyboard media key (`KeyboardEvent.key`) to its playback command.
 * `MediaPlay`/`MediaPause` are distinct from `MediaPlayPause` so a keyboard
 * with separate play and pause buttons does exactly one thing.
 */
export function mediaKeyAction(key: string): MediaKeyAction | null {
  switch (key) {
    case 'MediaPlay':
      return 'play';
    case 'MediaPause':
      return 'pause';
    case 'MediaPlayPause':
      return 'toggle';
    case 'MediaTrackNext':
      return 'next';
    case 'MediaTrackPrevious':
      return 'previous';
    default:
      return null;
  }
}

/**
 * Maps PageDown/PageUp to queue navigation (next/previous track), the desktop
 * convention for moving through a playlist without touching a slider.
 */
export function pageKeyAction(key: string): PageKeyAction | null {
  switch (key) {
    case 'PageDown':
      return 'next';
    case 'PageUp':
      return 'previous';
    default:
      return null;
  }
}
