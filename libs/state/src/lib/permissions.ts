import type { Role } from '@open-record/models';

/**
 * Things a member can do to a shared playlist. Pure data and functions so the
 * v2 backend and UI can reuse the same rules unchanged.
 */
export type PlaylistAction =
  | 'view'
  | 'play'
  | 'addTrack'
  | 'removeTrack'
  | 'reorder'
  | 'rename'
  | 'delete'
  | 'changeVisibility'
  | 'manageMembers';

export const PLAYLIST_ACTIONS: readonly PlaylistAction[] = [
  'view',
  'play',
  'addTrack',
  'removeTrack',
  'reorder',
  'rename',
  'delete',
  'changeVisibility',
  'manageMembers',
];

/** Higher rank includes every permission of the lower ranks. */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  viewer: 0,
  editor: 1,
  owner: 2,
};

/**
 * Least role that may perform each action. Matches the mockup: viewers
 * listen, editors manage records, the owner owns settings and membership.
 */
export const MIN_ROLE: Readonly<Record<PlaylistAction, Role>> = {
  view: 'viewer',
  play: 'viewer',
  addTrack: 'editor',
  removeTrack: 'editor',
  reorder: 'editor',
  rename: 'owner',
  delete: 'owner',
  changeVisibility: 'owner',
  manageMembers: 'owner',
};

/** True when `role` is `min` or higher. Unknown roles get nothing. */
export function hasRoleAtLeast(role: Role | null | undefined, min: Role): boolean {
  if (!role || !(role in ROLE_RANK)) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Whether a member with `role` may perform `action`. No role means no access. */
export function can(role: Role | null | undefined, action: PlaylistAction): boolean {
  const min = MIN_ROLE[action];
  return min !== undefined && hasRoleAtLeast(role, min);
}

/** Every action `role` may perform, in `PLAYLIST_ACTIONS` order. */
export function allowedActions(role: Role | null | undefined): PlaylistAction[] {
  return PLAYLIST_ACTIONS.filter((action) => can(role, action));
}

/**
 * Whether `actor` may give a member the role `next`. Only the owner manages
 * membership, and ownership itself is not assignable through a role change.
 */
export function canAssignRole(actor: Role | null | undefined, next: Role): boolean {
  return can(actor, 'manageMembers') && next !== 'owner';
}
