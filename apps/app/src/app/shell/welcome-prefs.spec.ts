import { readWelcomeDismissed, writeWelcomeDismissed } from './welcome-prefs';

describe('welcome prefs', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows the welcome until it is dismissed', () => {
    expect(readWelcomeDismissed()).toBe(false);

    writeWelcomeDismissed();

    expect(readWelcomeDismissed()).toBe(true);
  });

  it('blocked or throwing storage never throws; the welcome shows', () => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    try {
      expect(readWelcomeDismissed()).toBe(false);
      expect(() => writeWelcomeDismissed()).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
