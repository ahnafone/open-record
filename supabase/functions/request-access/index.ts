// POST {email, note?, turnstileToken} -> {status: "pending"}
// Public (verify_jwt = false). Records an access request for the admin to decide.
//
// Every accepted request gets the same 200 body, {status: "pending"}, whether the
// address is new, already pending, approved, denied or revoked. The error
// responses (400, 403, 429, 500) do not depend on whether the address exists:
// the Turnstile, source and pending-queue checks all run before the address
// lookup. Side effects happen server-side only:
//   - new address: row inserted; the admin is emailed, at most once per 10 minutes
//     across all requests (the dashboard shows the queue regardless). This email
//     is awaited, so a new address answers slightly slower than a known one.
//   - approved address: a "you already have access" email, at most once per hour
//     per address, sent in the background (not awaited, so its latency is not
//     visible). Pending, denied and revoked addresses get no email.
import { preflight } from "../_shared/cors.ts";
import { errorJson, json, readJsonObject } from "../_shared/json.ts";
import { requireEnv } from "../_shared/env.ts";
import { sendMail } from "../_shared/mail.ts";
import { UNKNOWN_SOURCE, clientIp, hashSource } from "../_shared/client-ip.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { verifyTurnstile } from "../_shared/turnstile.ts";
import { normalizeEmail, parseNote } from "../_shared/validate.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Abuse cap: once this many requests are waiting, new ones are refused until
// the admin works through the queue. Global count, not per hour.
const MAX_PENDING_REQUESTS = 500;
// Per source: more than this many request rows from one hashed source in the
// last hour are refused with 429. Counts rows, so repeats of an existing address
// do not add to it (they are still refused once the source is over the limit).
const MAX_ROWS_PER_SOURCE_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const ADMIN_NOTIFY_WINDOW_MS = 10 * 60 * 1000;
const APPROVED_NOTICE_WINDOW_MS = HOUR_MS;

// Responds with the same body for every outcome that is not an error.
const PENDING = { status: "pending" } as const;

/** ISO timestamp `ms` in the past, without fractional seconds (safe in PostgREST filters). */
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function handle(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorJson(405, "Method not allowed");

  const body = await readJsonObject(req);
  if (!body) return errorJson(400, "Invalid JSON body");

  const email = normalizeEmail(body.email);
  if (!email) return errorJson(400, "Invalid email address");

  const note = parseNote(body.note);
  if (note === undefined) return errorJson(400, "Note is invalid or longer than 500 characters");

  const ip = clientIp(req);
  const turnstileOk = await verifyTurnstile(body.turnstileToken, {
    secret: requireEnv("TURNSTILE_SECRET"),
    remoteIp: ip,
    expectedHostname: Deno.env.get("TURNSTILE_EXPECTED_HOSTNAME") || null,
  });
  if (!turnstileOk) return errorJson(403, "Verification failed");

  const db = serviceClient();

  // Per-source throttle. Checked before the address lookup and independent of
  // it, so the response does not reveal whether the address exists.
  const sourceHash = await hashSource(ip ?? UNKNOWN_SOURCE);
  const { count: sourceCount, error: sourceError } = await db
    .from("access_requests")
    .select("id", { count: "exact", head: true })
    .eq("source_ip_hash", sourceHash)
    .gte("requested_at", isoAgo(HOUR_MS));
  if (sourceError) {
    console.error("request-access: source count failed", sourceError.code ?? "unknown");
    return errorJson(500, "Could not record request");
  }
  if ((sourceCount ?? 0) > MAX_ROWS_PER_SOURCE_PER_HOUR) {
    return errorJson(429, "Too many requests from this network. Please try again later.");
  }

  // Queue cap before the address lookup, so the answer never depends on the address.
  const { count: pendingCount, error: countError } = await db
    .from("access_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (countError) {
    console.error("request-access: pending count failed", countError.code ?? "unknown");
    return errorJson(500, "Could not record request");
  }
  if ((pendingCount ?? 0) >= MAX_PENDING_REQUESTS) {
    return errorJson(429, "Too many pending requests. Please try again later.");
  }

  const { data: existing, error: readError } = await db
    .from("access_requests")
    .select("id, status")
    .eq("email", email)
    .maybeSingle();
  if (readError) {
    console.error("request-access: status lookup failed", readError.code ?? "unknown");
    return errorJson(500, "Could not record request");
  }
  if (existing) {
    if (existing.status === "approved") {
      inBackground(noticeAlreadyApproved(db, existing.id, email));
    }
    return json(PENDING);
  }

  // Admin notification throttle: skip the email if any request row was created
  // in the window, by anyone. Concurrent first requests may both send (best effort).
  const { count: recentCount, error: recentError } = await db
    .from("access_requests")
    .select("id", { count: "exact", head: true })
    .gte("requested_at", isoAgo(ADMIN_NOTIFY_WINDOW_MS));
  if (recentError) {
    console.error("request-access: recent count failed", recentError.code ?? "unknown");
  }
  const notifyAdmin = !recentError && (recentCount ?? 0) === 0;

  const { error: insertError } = await db
    .from("access_requests")
    .insert({ email, note, source_ip_hash: sourceHash });
  if (insertError) {
    // Unique violation: a concurrent request for the same address won the race.
    // Same response as any other existing address.
    if (insertError.code === "23505") return json(PENDING);
    console.error("request-access: insert failed", insertError.code ?? "unknown");
    return errorJson(500, "Could not record request");
  }

  if (notifyAdmin) {
    await sendMail(
      Deno.env.get("ADMIN_EMAIL"),
      "Open Record: new access request",
      [
        "A new access request was submitted.",
        "",
        `Email: ${email}`,
        `Note: ${note ?? "(none)"}`,
        "",
        "Approve, deny or revoke it from the admin screen.",
      ].join("\n"),
    );
  }

  return json(PENDING);
}

/**
 * Runs `task` after the response is sent. Uses EdgeRuntime.waitUntil when the
 * runtime provides it; otherwise the promise runs unawaited. Errors are logged
 * and never reach the caller.
 */
function inBackground(task: Promise<void>): void {
  const safe = task.catch((err) =>
    console.error("request-access: background task failed", err instanceof Error ? err.message : "unknown"),
  );
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(safe);
  else void safe;
}

/**
 * Emails the address that its access is already approved. At most once per
 * window per row: the conditional update claims the slot, so only one caller
 * sends. Never throws; the caller's response is the same either way.
 */
async function noticeAlreadyApproved(
  db: SupabaseClient,
  id: string,
  email: string,
): Promise<void> {
  const { data, error } = await db
    .from("access_requests")
    .update({ last_notice_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "approved")
    .or(`last_notice_at.is.null,last_notice_at.lt.${isoAgo(APPROVED_NOTICE_WINDOW_MS)}`)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("request-access: notice claim failed", error.code ?? "unknown");
    return;
  }
  if (!data) return; // within the cooldown, or no longer approved

  const appUrl = Deno.env.get("PUBLIC_APP_URL");
  await sendMail(
    email,
    "Open Record: you already have access",
    [
      "You already have access to Open Record.",
      "",
      `Sign in with your existing account: ${appUrl || "the Open Record app"}`,
    ].join("\n"),
  );
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("request-access: unexpected error", err instanceof Error ? err.message : "unknown");
    return errorJson(500, "Server error");
  }
});
