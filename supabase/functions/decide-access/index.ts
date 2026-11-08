// POST {id, action: 'approve' | 'deny' | 'revoke'} -> {request}
// Admin only (verify_jwt = true, plus requireAdmin).
//
//   approve: from pending | denied | revoked. If an Auth account exists for the
//            address: an UNCONFIRMED account that has never signed in is deleted
//            (it never completed sign-up, so nothing is lost) and a fresh invite is
//            sent. An unconfirmed account that HAS signed in is refused with 409 and
//            left alone. A CONFIRMED account is un-banned and emailed a sign-in
//            notice. With no account, a Supabase invite is sent.
//   deny:    from pending. Emails the requester. Refused for the admin account.
//   revoke:  from approved. Bans the Auth account and emails the user. Refused for
//            the admin account. The ban stops token refresh; the server enforces
//            approval within ~60 s for HTTP and open websockets. A Supabase access
//            token already issued stays valid for the Supabase REST API until it
//            expires (jwt_expiry, 1 h by default); that API only returns the user's
//            own rows under RLS. Accepted.
import { preflight } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/admin.ts";
import { errorJson, json, readJsonObject } from "../_shared/json.ts";
import { sendMail } from "../_shared/mail.ts";
import { isUuid } from "../_shared/validate.ts";
import type { SupabaseClient, User } from "npm:@supabase/supabase-js@2";

type Status = "pending" | "approved" | "denied" | "revoked";
type Action = "approve" | "deny" | "revoke";

const ALLOWED_FROM: Record<Action, readonly Status[]> = {
  approve: ["pending", "denied", "revoked"],
  deny: ["pending"],
  revoke: ["approved"],
};

// Effectively permanent (100 years); "none" lifts it.
const BAN_DURATION = "876000h";
const NO_BAN = "none";

// Email search over the Auth user list is bounded: at most this many pages of
// USER_PAGE_SIZE users. Beyond that the request fails loudly rather than missing
// an existing account.
const USER_PAGE_SIZE = 1000;
const MAX_USER_PAGES = 10;

const APP_URL_KEY = "PUBLIC_APP_URL";

interface AccessRequestRow {
  id: string;
  email: string;
  note: string | null;
  status: Status;
  user_id: string | null;
  requested_at: string;
  decided_at: string | null;
}

type AuthLookup = { ok: true; user: User | null } | { ok: false; response: Response };

function isAction(value: unknown): value is Action {
  return value === "approve" || value === "deny" || value === "revoke";
}

/** True if the row is the admin's own request/account. Such a row is never denied or revoked. */
function isAdminRow(row: AccessRequestRow): boolean {
  const adminId = (Deno.env.get("ADMIN_USER_ID") ?? "").trim().toLowerCase();
  const adminEmail = (Deno.env.get("ADMIN_EMAIL") ?? "").trim().toLowerCase();
  return (
    (adminId !== "" && row.user_id?.toLowerCase() === adminId) ||
    (adminEmail !== "" && row.email.toLowerCase() === adminEmail)
  );
}

async function handle(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorJson(405, "Method not allowed");

  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;
  const db = admin.db;

  const body = await readJsonObject(req);
  if (!body) return errorJson(400, "Invalid JSON body");
  if (!isUuid(body.id)) return errorJson(400, "Invalid id");
  if (!isAction(body.action)) return errorJson(400, "action must be approve, deny or revoke");
  const id = body.id;
  const action = body.action;

  const { data, error: readError } = await db
    .from("access_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readError) {
    console.error("decide-access: read failed", readError.code ?? "unknown");
    return errorJson(500, "Could not load request");
  }
  const row = data as AccessRequestRow | null;
  if (!row) return errorJson(404, "Request not found");

  if (!ALLOWED_FROM[action].includes(row.status)) {
    return errorJson(409, `Cannot ${action} a request that is ${row.status}`);
  }
  if ((action === "deny" || action === "revoke") && isAdminRow(row)) {
    return errorJson(409, "The admin account cannot be denied or revoked");
  }

  switch (action) {
    case "approve":
      return approve(db, row);
    case "deny":
      return deny(db, row);
    case "revoke":
      return revoke(db, row);
  }
}

async function approve(db: SupabaseClient, row: AccessRequestRow): Promise<Response> {
  const appUrl = Deno.env.get(APP_URL_KEY) || undefined;

  const lookup = await findAuthUser(db, row);
  if (!lookup.ok) return lookup.response;
  let existing = lookup.user;

  if (existing && !existing.email_confirmed_at) {
    // Signed in without confirming: it is not a dead invite, so never delete it.
    if (existing.last_sign_in_at) {
      return errorJson(
        409,
        "This account is unconfirmed but has signed in before, so it was not deleted. Resolve it in the Supabase dashboard.",
      );
    }
    // Never confirmed (e.g. an invite that was never accepted). Delete it so the
    // fresh invite below is the only way in. Such an account has no real data.
    const { error: deleteError } = await db.auth.admin.deleteUser(existing.id);
    if (deleteError && deleteError.status !== 404) {
      console.error("decide-access: delete unconfirmed failed", deleteError.status ?? "unknown");
      return errorJson(500, "Could not reset the unconfirmed account");
    }
    existing = null;
  }

  if (existing) {
    // Confirmed account: re-enable it if an earlier revoke banned it.
    const { error: unbanError } = await db.auth.admin.updateUserById(existing.id, {
      ban_duration: NO_BAN,
    });
    if (unbanError) {
      console.error("decide-access: unban failed", unbanError.status ?? "unknown");
      return errorJson(500, "Could not restore access");
    }
    await sendMail(
      row.email,
      "Your Open Record access is approved",
      [
        "Your access request for Open Record was approved.",
        "",
        `Sign in with your existing account: ${appUrl ?? "the Open Record app"}`,
      ].join("\n"),
    );
    return saveDecision(db, row, "approved", existing.id);
  }

  const invited = await db.auth.admin.inviteUserByEmail(row.email, { redirectTo: appUrl });
  if (invited.error || !invited.data.user) {
    console.error("decide-access: invite failed", invited.error?.status ?? "unknown");
    return errorJson(502, "Could not send invite. Check Auth SMTP settings.");
  }
  return saveDecision(db, row, "approved", invited.data.user.id);
}

async function deny(db: SupabaseClient, row: AccessRequestRow): Promise<Response> {
  const response = await saveDecision(db, row, "denied", row.user_id);
  if (response.status === 200) {
    await sendMail(
      row.email,
      "Open Record access request",
      "Thanks for your interest in Open Record. We are not able to approve your access request at this time.",
    );
  }
  return response;
}

async function revoke(db: SupabaseClient, row: AccessRequestRow): Promise<Response> {
  if (row.user_id) {
    // Ban first: if this fails the request stays "approved" and nothing changes.
    const { error: banError } = await db.auth.admin.updateUserById(row.user_id, {
      ban_duration: BAN_DURATION,
    });
    // 404 = the Auth account was already deleted by its owner; nothing to ban.
    if (banError && banError.status !== 404) {
      console.error("decide-access: ban failed", banError.status ?? "unknown");
      return errorJson(500, "Could not revoke access");
    }
  }

  const response = await saveDecision(db, row, "revoked", row.user_id);
  if (response.status === 200) {
    await sendMail(
      row.email,
      "Your Open Record access has been revoked",
      "Your access to Open Record has been revoked. If you think this is a mistake, contact the administrator.",
    );
  }
  return response;
}

/**
 * Finds the Auth account for the row's address. A stored user_id that resolves
 * to an Auth user is used as-is (one getUserById call), even if its email
 * differs from the row's. Only when there is no such user does it fall back to
 * a bounded email search.
 */
async function findAuthUser(db: SupabaseClient, row: AccessRequestRow): Promise<AuthLookup> {
  const target = row.email.toLowerCase();

  if (row.user_id) {
    const { data, error } = await db.auth.admin.getUserById(row.user_id);
    if (!error && data.user) return { ok: true, user: data.user };
  }

  for (let page = 1; page <= MAX_USER_PAGES; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: USER_PAGE_SIZE });
    if (error) {
      console.error("decide-access: listUsers failed", error.status ?? "unknown");
      return { ok: false, response: errorJson(500, "Could not look up the account") };
    }
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return { ok: true, user: match };
    if (data.users.length < USER_PAGE_SIZE) return { ok: true, user: null };
  }

  console.error("decide-access: account search exceeded page cap");
  return {
    ok: false,
    response: errorJson(
      500,
      `Account search stopped after ${MAX_USER_PAGES * USER_PAGE_SIZE} users. Find the address in the Supabase dashboard.`,
    ),
  };
}

/**
 * Writes the new status. Guarded on the status we read, so a concurrent
 * decision cannot be overwritten (returns 409 instead).
 */
async function saveDecision(
  db: SupabaseClient,
  row: AccessRequestRow,
  status: Status,
  userId: string | null,
): Promise<Response> {
  const { data, error } = await db
    .from("access_requests")
    .update({ status, user_id: userId, decided_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", row.status)
    .select("*")
    .maybeSingle();
  if (error) {
    console.error("decide-access: update failed", error.code ?? "unknown");
    return errorJson(500, "Could not save decision");
  }
  if (!data) return errorJson(409, "Request changed while it was being decided. Reload and retry.");
  return json({ request: data as AccessRequestRow });
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("decide-access: unexpected error", err instanceof Error ? err.message : "unknown");
    return errorJson(500, "Server error");
  }
});
