// Transactional email through Resend. Never throws: a mail failure is logged and
// the calling request still succeeds (the decision is already recorded).
// Logs carry no addresses, bodies or keys.
export async function sendMail(
  to: string | null | undefined,
  subject: string,
  text: string,
): Promise<void> {
  try {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("MAIL_FROM");
    if (!to || !apiKey || !from) {
      console.error("mail: skipped, RESEND_API_KEY / MAIL_FROM / recipient missing");
      return;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) console.error("mail: Resend rejected message", res.status);
  } catch (err) {
    console.error("mail: send failed", err instanceof Error ? err.name : "unknown");
  }
}
