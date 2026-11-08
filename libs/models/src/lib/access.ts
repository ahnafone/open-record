/**
 * Access requests on the public Open Record server. Only the public server
 * takes requests (sign-up is closed there); the admin decides each one.
 */

export const ACCESS_STATUSES = ['pending', 'approved', 'denied', 'revoked'] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

/** Admin decisions: approve (also re-approves), deny (pending only), revoke (approved only). */
export const ACCESS_ACTIONS = ['approve', 'deny', 'revoke'] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

/** Longest note a requester may send (matches the server's limit). */
export const MAX_ACCESS_NOTE_LENGTH = 500;

export function isAccessStatus(value: unknown): value is AccessStatus {
  return typeof value === 'string' && (ACCESS_STATUSES as readonly string[]).includes(value);
}

/** One row of `access_requests`, as the admin functions return it. */
export interface AccessRequest {
  id: string;
  email: string;
  note: string | null;
  status: AccessStatus;
  /** Auth user created by the invite (null until the request is approved). */
  user_id: string | null;
  /** ISO timestamp. */
  requested_at: string;
  /** ISO timestamp of the last decision (null while pending). */
  decided_at: string | null;
}
