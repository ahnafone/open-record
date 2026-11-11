/** Movement (px, from the press point) before a gesture picks an axis. */
export const SWIPE_AXIS_PX = 8;
/** Distance (px) a right swipe must reach to commit on release. */
export const SWIPE_COMMIT_PX = 88;
/** Reveal width (px) past which further drag is damped instead of followed. */
export const SWIPE_MAX_PX = 120;

export type SwipeAxis = 'pending' | 'horizontal' | 'vertical';

/**
 * Which way a gesture is moving, once it has travelled far enough to tell.
 * Mostly-vertical movement is `vertical` and belongs to scrolling.
 */
export function swipeAxis(dx: number, dy: number): SwipeAxis {
  if (Math.hypot(dx, dy) < SWIPE_AXIS_PX) return 'pending';
  return Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
}

/** Reveal width for a horizontal drag: only rightward drags reveal, damped past `SWIPE_MAX_PX`. */
export function swipeOffset(dx: number): number {
  if (dx <= 0) return 0;
  if (dx <= SWIPE_MAX_PX) return dx;
  return SWIPE_MAX_PX + (dx - SWIPE_MAX_PX) * 0.25;
}

/** Whether releasing at this reveal width commits the action. */
export function swipeCommits(offset: number): boolean {
  return offset >= SWIPE_COMMIT_PX;
}
