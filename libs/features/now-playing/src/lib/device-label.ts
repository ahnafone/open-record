import type { SessionDevice, SessionTarget } from '@open-record/models';

/**
 * Human name for a session target, shared by the Now Playing header and its
 * status line. Local playback (no session target) is this device; a target
 * we cannot resolve yet falls back to a generic noun instead of an id.
 */
export function deviceTargetName(
  target: SessionTarget | null,
  clientId: string,
  devices: readonly SessionDevice[],
): string {
  if (!target) return 'This device';
  if (target.kind === 'cast') {
    const cast = devices.find(
      (device) =>
        device.platform === 'cast' &&
        (device.castId ?? device.id) === target.castId,
    );
    return cast?.name ?? 'speaker';
  }
  if (target.clientId === clientId) return 'This device';
  return (
    devices.find((device) => device.id === target.clientId)?.name ??
    'another device'
  );
}
