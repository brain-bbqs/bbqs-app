// One-click onboarding reminder: emails a member the onboarding steps still remaining.
// Called from the pipeline status panel. Resend, mirrors send-welcome-email.
// Deploy: supabase functions deploy send-onboarding-reminder  (needs RESEND_API_KEY).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bbqs-client",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// Use REMINDER_FROM only if it's a valid `email` or `Name <email>` string; else the safe
// default (a malformed env value here 422s every send — Resend "Invalid `from` field").
const FROM_RE = /^(?:[^<>]+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>|[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)$/;
const _rf = (Deno.env.get("REMINDER_FROM") || "").trim();
const FROM_ADDRESS = FROM_RE.test(_rf) ? _rf : "BBQS <noreply@brain-bbqs.org>";
const SIGN_IN_URL = Deno.env.get("WELCOME_SIGNIN_URL") || "https://brain-bbqs.org/auth";

// Friendly labels for the persisted checklist keys.
const STEP_LABELS: Record<string, string> = {
  kg_created: "Create your member profile",
  grant_link: "Confirm your grant",
  consortium_group: "Join the consortium mailing list",
  pi_group: "Join the PI mailing list",
  young_investigators_group: "Join the young-investigators group",
  wg_groups: "Join your working group(s)",
  welcome_email: "Read your welcome email",
  data_questionnaire: "Complete your project's data questionnaire",
  slack: "Join the BBQS Slack",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  try {
    const { to, name, steps } = await req.json().catch(() => ({}));
    if (!to || typeof to !== "string") return json({ success: false, error: "Missing 'to'" }, 400);
    const remaining: string[] = Array.isArray(steps) ? steps : [];
    if (!remaining.length) return json({ success: false, error: "No remaining steps" }, 400);

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) return json({ success: false, error: "RESEND_API_KEY not configured" }, 500);

    const displayName = (name || to.split("@")[0] || "there").trim();
    const items = remaining.map((k) => `<li style="margin:4px 0;">${STEP_LABELS[k] || k}</li>`).join("");
    const subject = "A few steps left to finish your BBQS onboarding";
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#1a2247;padding:24px;border-radius:8px 8px 0 0;"><h1 style="color:#f5b942;margin:0;font-size:22px;">BBQS Consortium</h1></div>
        <div style="padding:28px;background:#f7f8fa;border-radius:0 0 8px 8px;">
          <p>Hi ${displayName},</p>
          <p>Thanks for joining BBQS! A few onboarding steps are still outstanding:</p>
          <ul style="padding-left:20px;">${items}</ul>
          <p style="text-align:center;margin:28px 0;">
            <a href="${SIGN_IN_URL}" style="background:#f5b942;color:#1a2247;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block;">Sign in to continue</a>
          </p>
          <p style="font-size:13px;color:#666;">Questions? Email <a href="mailto:dcaic-admin@brain-bbqs.org">dcaic-admin@brain-bbqs.org</a>.</p>
          <p style="font-size:13px;color:#666;">— The BBQS Admin team</p>
        </div>
      </div>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
    });
    const data = await res.json();
    if (!res.ok) return json({ success: false, error: data }, 502);
    return json({ success: true, id: data.id });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
