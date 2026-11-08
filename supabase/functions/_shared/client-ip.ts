// Source identification for request-access throttling. The raw IP is used only
// for the Turnstile remoteip check and is never stored or logged; the database
// gets a salted hash.
//
// Caveat: the Supabase Edge gateway is not behind a proxy you control, so
// cf-connecting-ip and x-forwarded-for are client-influenceable. The throttle is best-effort abuse
// reduction, not a hard guarantee.

export const UNKNOWN_SOURCE = "unknown";

/** Client IP from cf-connecting-ip, else the first x-forwarded-for entry; null if neither. */
export function clientIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || null;
}

/**
 * Hex SHA-256 of `${REQUEST_IP_SALT}:${source}`. Falls back to a constant label
 * when the salt is unset (hashes are then only as private as the IP space is
 * small; set REQUEST_IP_SALT in production).
 */
export async function hashSource(source: string): Promise<string> {
  const salt = Deno.env.get("REQUEST_IP_SALT") || "open-record-request-ip";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${source}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
