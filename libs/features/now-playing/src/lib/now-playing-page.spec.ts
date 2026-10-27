import { formatTime } from './time';

describe('formatTime', () => {
  it('formats seek times and guards bad input', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(83.9)).toBe('1:23');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatTime(-5)).toBe('0:00');
  });
});
