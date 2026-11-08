// CORS for the Edge Functions. The API is protected by the caller's JWT (admin
// functions) or Turnstile (request-access), not by origin, so a wildcard origin
// is acceptable here.
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

/** Answers a CORS preflight; returns null for any other request. */
export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders });
}
