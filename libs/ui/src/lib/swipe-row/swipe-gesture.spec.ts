import {
  SWIPE_COMMIT_PX,
  SWIPE_MAX_PX,
  swipeAxis,
  swipeCommits,
  swipeOffset,
} from './swipe-gesture';

describe('swipe gesture', () => {
  it('ignores mostly-vertical movement so scrolling keeps the row', () => {
    expect(swipeAxis(4, 60)).toBe('vertical');
    expect(swipeAxis(-30, 40)).toBe('vertical');
  });

  it('picks a horizontal axis for a rightward or leftward drag', () => {
    expect(swipeAxis(60, 10)).toBe('horizontal');
    expect(swipeAxis(-60, 5)).toBe('horizontal');
  });

  it('stays pending until the finger has travelled far enough', () => {
    expect(swipeAxis(3, 2)).toBe('pending');
  });

  it('reveals only on rightward drags, damping past the max', () => {
    expect(swipeOffset(-40)).toBe(0);
    expect(swipeOffset(50)).toBe(50);
    expect(swipeOffset(SWIPE_MAX_PX + 100)).toBeLessThan(SWIPE_MAX_PX + 100);
    expect(swipeOffset(SWIPE_MAX_PX + 100)).toBeGreaterThan(SWIPE_MAX_PX);
  });

  it('commits only at or past the threshold', () => {
    expect(swipeCommits(SWIPE_COMMIT_PX - 1)).toBe(false);
    expect(swipeCommits(SWIPE_COMMIT_PX)).toBe(true);
  });
});
