// Sends a BBQS welcome email on onboarding (the one email capability the KG side lacked;
// the chat agent had its own). Mirrors send-access-approved-email (Resend). Called by the
// onboard wizard after onboard_member succeeds; on success the wizard marks the
// welcome_email checklist step done via set_onboarding_step.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bbqs-client",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Use WELCOME_FROM only if it's a valid `email` or `Name <email>` string; else the default.
const FROM_RE = /^(?:[^<>]+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>|[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)$/;
const _wf = (Deno.env.get("WELCOME_FROM") || "").trim();
const FROM_ADDRESS = FROM_RE.test(_wf) ? _wf : "BBQS <noreply@brain-bbqs.org>";
const SIGN_IN_URL = Deno.env.get("WELCOME_SIGNIN_URL") || "https://brain-bbqs.org/auth";

// Non-research roles get the lighter template (no data-questionnaire / research asks).
const NON_RESEARCH = new Set(["nih_program", "admin"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { to, name, role } = await req.json();
    if (!to || typeof to !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'to'" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      console.warn("RESEND_API_KEY not configured");
      return new Response(JSON.stringify({ success: false, error: "RESEND_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const displayName = (name || to.split("@")[0] || "there").trim();
    const isNonResearch = NON_RESEARCH.has(String(role || "").toLowerCase());
    const subject = "Welcome to the BBQS Consortium";
    const researchBlurb = isNonResearch
      ? `<p>You're all set. You can sign in any time to access the consortium portal.</p>`
      : `<p>Once you sign in you can complete your profile, link your grant, and fill out your project's data questionnaire. Your working-group and mailing-list access is being set up automatically.</p>`;

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
        <div style="background: #1a2247; padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #f5b942; margin: 0; font-size: 22px;">BBQS Consortium</h1>
        </div>
        <div style="padding: 28px; background: #f7f8fa; border-radius: 0 0 8px 8px;">
          <p>Hi ${displayName},</p>
          <p>Welcome to the <strong>Brain Behavior Quantification &amp; Synchronization (BBQS)</strong> consortium! Your member profile has been created.</p>
          ${researchBlurb}
          <p>Sign in via Globus using this email address (<code>${to}</code>):</p>
          <p style="text-align: center; margin: 28px 0;">
            <a href="${SIGN_IN_URL}" style="background: #f5b942; color: #1a2247; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
              Sign in to BBQS
            </a>
          </p>
          <p style="font-size: 13px; color: #666; margin-top: 24px;">
            Questions? Email <a href="mailto:dcaic-admin@brain-bbqs.org">dcaic-admin@brain-bbqs.org</a>.
          </p>
          <p style="font-size: 13px; color: #666;">— The BBQS Admin team</p>
        </div>
      </div>
    `;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
    });

    const data = await resendRes.json();
    if (!resendRes.ok) {
      console.error("Resend error:", JSON.stringify(data));
      return new Response(JSON.stringify({ success: false, error: data }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Welcome email sent:", data.id, "to", to);
    return new Response(JSON.stringify({ success: true, id: data.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send-welcome-email error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
