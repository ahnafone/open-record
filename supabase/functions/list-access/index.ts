// GET or POST (no body) -> {requests: [...]} newest first.
// Admin only (verify_jwt = true, plus requireAdmin).
import { preflight } from "../_shared/cors.ts";
import { errorJson, json } from "../_shared/json.ts";
import { requireAdmin } from "../_shared/admin.ts";

async function handle(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "GET" && req.method !== "POST") return errorJson(405, "Method not allowed");

  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const { data, error } = await admin.db
    .from("access_requests")
    .select("*")
    .order("requested_at", { ascending: false });
  if (error) {
    console.error("list-access: query failed", error.code ?? "unknown");
    return errorJson(500, "Could not load requests");
  }
  return json({ requests: data ?? [] });
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("list-access: unexpected error", err instanceof Error ? err.message : "unknown");
    return errorJson(500, "Server error");
  }
});
