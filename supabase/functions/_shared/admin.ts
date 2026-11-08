import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { errorJson } from "./json.ts";
import { serviceClient } from "./supabase.ts";

export type AdminCheck =
  | { ok: true; db: SupabaseClient }
  | { ok: false; response: Response };

/**
 * Admin gate for the admin functions. The caller's JWT is validated by Auth
 * (getUser), then its user id must equal ADMIN_USER_ID. Anything else is 401/403.
 */
export async function requireAdmin(req: Request): Promise<AdminCheck> {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) return { ok: false, response: errorJson(401, "Unauthorized") };

  const adminId = (Deno.env.get("ADMIN_USER_ID") ?? "").toLowerCase();
  if (!adminId) {
    console.error("admin: ADMIN_USER_ID is not set");
    return { ok: false, response: errorJson(500, "Server misconfigured") };
  }

  const db = serviceClient();
  const { data, error } = await db.auth.getUser(match[1]);
  if (error || !data.user) return { ok: false, response: errorJson(401, "Unauthorized") };
  if (data.user.id.toLowerCase() !== adminId) {
    return { ok: false, response: errorJson(403, "Forbidden") };
  }
  return { ok: true, db };
}
