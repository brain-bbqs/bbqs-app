const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FROM_ADDRESS =
  Deno.env.get("ACCESS_APPROVED_FROM") ||
  "BBQS <noreply@brain-bbqs.org>";
const SIGN_IN_URL =
  Deno.env.get("ACCESS_APPROVED_SIGNIN_URL") ||
  "https://bbqs-app.lovable.app/auth";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { to, name, note } = await req.json();
    if (!to || typeof to !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'to'" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      console.warn("RESEND_API_KEY not configured");
      return new Response(
        JSON.stringify({ success: false, error: "RESEND_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const displayName = (name || to.split("@")[0] || "there").trim();
    const subject = "Your BBQS access has been approved";
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
        <div style="background: #1a2247; padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #f5b942; margin: 0; font-size: 22px;">BBQS Consortium</h1>
        </div>
        <div style="padding: 28px; background: #f7f8fa; border-radius: 0 0 8px 8px;">
          <p>Hi ${displayName},</p>
          <p>Good news — your access request to the <strong>BBQS Consortium</strong> portal has been approved by a curator.</p>
          <p>You can now sign in via Globus using this email address (<code>${to}</code>):</p>
          <p style="text-align: center; margin: 28px 0;">
            <a href="${SIGN_IN_URL}" style="background: #f5b942; color: #1a2247; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
              Sign in to BBQS
            </a>
          </p>
          ${note ? `<p style="background: #fff; padding: 12px; border-left: 3px solid #f5b942; font-size: 14px;"><strong>Note from the curator:</strong><br/>${note}</p>` : ""}
          <p style="font-size: 13px; color: #666; margin-top: 24px;">
            If you have trouble signing in, email <a href="mailto:dcaic-admin@brain-bbqs.org">dcaic-admin@brain-bbqs.org</a> and we'll help you out.
          </p>
          <p style="font-size: 13px; color: #666;">— The BBQS Admin team</p>
        </div>
      </div>
    `;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [to],
        subject,
        html,
      }),
    });

    const data = await resendRes.json();
    if (!resendRes.ok) {
      console.error("Resend error:", JSON.stringify(data));
      return new Response(
        JSON.stringify({ success: false, error: data }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log("Access-approved email sent:", data.id, "to", to);
    return new Response(
      JSON.stringify({ success: true, id: data.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("send-access-approved-email error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});