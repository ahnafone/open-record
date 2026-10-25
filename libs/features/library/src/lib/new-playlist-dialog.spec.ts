import { PLAYLIST_NAME_MAX } from '@open-record/state';
import { playlistNameError } from './new-playlist-dialog';

describe('playlistNameError', () => {
  it('rejects blank and over-long names, accepts trimmed valid ones', () => {
    expect(playlistNameError('   ')).not.toBe('');
    expect(playlistNameError('a'.repeat(PLAYLIST_NAME_MAX + 1))).not.toBe('');
    expect(playlistNameError(`  ${'a'.repeat(PLAYLIST_NAME_MAX)}  `)).toBe('');
  });
});
