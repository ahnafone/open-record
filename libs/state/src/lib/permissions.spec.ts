import type { Role } from '@open-record/models';
import {
  PLAYLIST_ACTIONS,
  allowedActions,
  can,
  canAssignRole,
} from './permissions';

describe('role permissions', () => {
  it('viewers listen, editors manage records, owners control everything', () => {
    expect(allowedActions('viewer')).toEqual(['view', 'play']);
    expect(allowedActions('editor')).toEqual([
      'view',
      'play',
      'addTrack',
      'removeTrack',
      'reorder',
    ]);
    expect(allowedActions('owner')).toEqual([...PLAYLIST_ACTIONS]);
  });

  it('is monotonic: a higher role can do everything a lower one can', () => {
    const order: Role[] = ['viewer', 'editor', 'owner'];
    for (const action of PLAYLIST_ACTIONS) {
      const allowed = order.map((r) => can(r, action));
      expect(allowed).toEqual(
        [...allowed].sort((a, b) => Number(a) - Number(b)),
      );
    }
  });

  it('denies everything without a valid role', () => {
    for (const action of PLAYLIST_ACTIONS) {
      expect(can(null, action)).toBe(false);
      expect(can(undefined, action)).toBe(false);
      expect(can('admin' as Role, action)).toBe(false);
    }
  });

  it('only owners assign roles, and never ownership', () => {
    expect(canAssignRole('owner', 'editor')).toBe(true);
    expect(canAssignRole('owner', 'owner')).toBe(false);
    expect(canAssignRole('editor', 'viewer')).toBe(false);
  });
});
