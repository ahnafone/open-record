// Pure input helpers (no Deno or network access), so they can be unit-tested
// with plain Node/vitest if that is ever wanted.

export const MAX_EMAIL_LENGTH = 254;
export const MAX_NOTE_LENGTH = 500;

// Deliberately simple: ASCII local part and dotted ASCII domain. Anything
// unusual is rejected rather than accepted, which keeps the stored value safe
// to use in mail headers and admin views. Real verification is the invite email.
const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Trims and lowercases an email, or returns null if it is not a valid address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return null;
  return EMAIL_RE.test(email) ? email : null;
}

/**
 * Optional note: missing/blank becomes null. Returns undefined when the value
 * is the wrong type or too long (caller responds 400).
 */
export function parseNote(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const note = raw.trim();
  if (note.length === 0) return null;
  if ([...note].length > MAX_NOTE_LENGTH) return undefined;
  return note;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
