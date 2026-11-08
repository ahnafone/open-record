const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 5000;

export interface TurnstileOptions {
  secret: string;
  /** Client IP, passed to siteverify as `remoteip` when known. */
  remoteIp?: string | null;
  /** If set, the hostname Turnstile reports must match (case-insensitive). */
  expectedHostname?: string | null;
}

/**
 * Verifies a Turnstile token. Fails closed: a missing token, a rejected token,
 * a hostname mismatch, a timeout or an unreachable siteverify endpoint all
 * return false.
 */
export async function verifyTurnstile(token: unknown, opts: TurnstileOptions): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  try {
    const form = new URLSearchParams({ secret: opts.secret, response: token });
    if (opts.remoteIp) form.set("remoteip", opts.remoteIp);
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown; hostname?: unknown };
    if (data.success !== true) return false;
    if (opts.expectedHostname) {
      const reported = typeof data.hostname === "string" ? data.hostname.toLowerCase() : "";
      if (reported !== opts.expectedHostname.toLowerCase()) {
        console.error("turnstile: hostname mismatch");
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error("turnstile: siteverify failed", err instanceof Error ? err.name : "unknown");
    return false;
  }
}
