import { formatAddedAt } from './row-format';

describe('playlist row format', () => {
  it('shows a dash for missing dates', () => {
    expect(formatAddedAt(undefined)).toBe('—');
  });
});
