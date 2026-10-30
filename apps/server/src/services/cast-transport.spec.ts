import type { CastMediaStatus } from 'castv2-client';
import { toCastStatus } from './cast-transport';

function status(overrides: CastMediaStatus): CastMediaStatus {
  return { playerState: 'PLAYING', currentTime: 0, ...overrides };
}

describe('toCastStatus', () => {
  it('maps PLAYING, position, duration and volume', () => {
    expect(
      toCastStatus(
        status({
          currentTime: 42.5,
          media: { duration: 210 },
        }),
        0.35,
      ),
    ).toEqual({ playing: true, positionSec: 42.5, durationSec: 210, volume: 0.35 });
  });

  it('maps PAUSED and IDLE/FINISHED', () => {
    expect(toCastStatus(status({ playerState: 'PAUSED' }), 0.2)).toEqual({
      playing: false,
      positionSec: 0,
      volume: 0.2,
    });
    expect(
      toCastStatus(
        status({
          playerState: 'IDLE',
          idleReason: 'FINISHED',
          media: { duration: 180 },
        }),
        0.2,
      ),
    ).toEqual({ playing: false, positionSec: 0, durationSec: 180, idle: true, volume: 0.2 });
  });

  it('omits idle for non-FINISHED reasons and ignores non-finite timings', () => {
    const mapped = toCastStatus({ playerState: 'BUFFERING', idleReason: 'CANCELLED', currentTime: Number.NaN }, 0.5);
    expect(mapped).toEqual({ playing: false, positionSec: 0, volume: 0.5 });
  });

  it('clamps the receiver volume into 0..1', () => {
    expect(toCastStatus(status({}), 2).volume).toBe(1);
    expect(toCastStatus(status({}), -1).volume).toBe(0);
  });
});
