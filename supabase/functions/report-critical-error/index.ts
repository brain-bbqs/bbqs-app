import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALERT_RECIPIENT = "nader.nikbakht@gmail.com";
const GITHUB_REPO = "brain-bbqs/bbqs-app"; // owner/repo; non-fatal if wrong

interface AlertPayload {
  source: string;
  errorCode: string;
  message: string;
  severity?: "info" | "warning" | "critical";
  details?: Record<string, unknown>;
}

/**
 * Build a stable fingerprint so repeat errors increment a counter
 * instead of flooding the table / inbox.
 */
function fingerprint(p: AlertPayload): string {
  // Strip volatile bits from details (timestamps, request ids, user ids)
  return `${p.source}::${p.errorCode}::${p.message.slice(0, 120)}`;
}

async function sendEmail(alert: AlertPayload, occurrenceCount: number): Promise<boolean> {
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_API_KEY) {
    console.warn("[report-critical-error] RESEND_API_KEY missing — skipping email");
    return false;
  }

  const detailsBlock = alert.details
    ? `<pre style="background:#f4f4f4;padding:12px;border-radius:6px;font-size:12px;overflow:auto">${
        JSON.stringify(alert.details, null, 2).replace(/</g, "&lt;")
      }</pre>`
    : "";

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:640px">
      <h2 style="color:#dc2626;margin:0 0 8px">🚨 BBQS Critical Alert</h2>
      <p style="color:#666;margin:0 0 16px">Severity: <strong>${alert.severity ?? "critical"}</strong> · Occurrences so far: <strong>${occurrenceCount}</strong></p>
      <table style="border-collapse:collapse;width:100%;margin-bottom:16px">
        <tr><td style="padding:6px 8px;background:#f9fafb;font-weight:600;width:120px">Source</td><td style="padding:6px 8px">${alert.source}</td></tr>
        <tr><td style="padding:6px 8px;background:#f9fafb;font-weight:600">Error code</td><td style="padding:6px 8px"><code>${alert.errorCode}</code></td></tr>
        <tr><td style="padding:6px 8px;background:#f9fafb;font-weight:600">Message</td><td style="padding:6px 8px">${alert.message}</td></tr>
        <tr><td style="padding:6px 8px;background:#f9fafb;font-weight:600">Time</td><td style="padding:6px 8px">${new Date().toISOString()}</td></tr>
      </table>
      ${detailsBlock}
      <p style="color:#999;font-size:12px;margin-top:24px">Sent automatically by report-critical-error. Resolve in the Admin → Alerts dashboard.</p>
    </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "BBQS Alerts <noreply@brain-bbqs.org>",
        to: [ALERT_RECIPIENT],
        subject: `🚨 [BBQS] ${alert.source}: ${alert.errorCode}`,
        html,
      }),
    });
    if (!res.ok) {
      console.error("[report-critical-error] Resend non-OK:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[report-critical-error] Resend threw:", e);
    return false;
  }
}

async function fileGithubIssue(
  alert: AlertPayload,
): Promise<{ url: string | null; number: number | null }> {
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) {
    console.warn("[report-critical-error] GITHUB_TOKEN missing — skipping issue");
    return { url: null, number: null };
  }

  const body = [
    `**Source:** \`${alert.source}\``,
    `**Error code:** \`${alert.errorCode}\``,
    `**Severity:** ${alert.severity ?? "critical"}`,
    `**First seen:** ${new Date().toISOString()}`,
    "",
    `### Message`,
    alert.message,
    "",
    "### Details",
    "```json",
    JSON.stringify(alert.details ?? {}, null, 2),
    "```",
    "",
    "_Auto-filed by `report-critical-error`. Close this issue once resolved — the system will reopen if it recurs._",
  ].join("\n");

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `🚨 [${alert.source}] ${alert.errorCode}: ${alert.message.slice(0, 100)}`,
        body,
        labels: ["bug", "critical", "auto-filed"],
      }),
    });
    if (!res.ok) {
      console.error("[report-critical-error] GitHub non-OK:", res.status, await res.text());
      return { url: null, number: null };
    }
    const data = await res.json();
    return { url: data.html_url ?? null, number: data.number ?? null };
  } catch (e) {
    console.error("[report-critical-error] GitHub threw:", e);
    return { url: null, number: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Service-role-only — only edge functions should be calling this
    const authHeader = req.headers.get("authorization") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!serviceKey || !authHeader.includes(serviceKey)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = (await req.json()) as AlertPayload;
    if (!payload?.source || !payload?.errorCode || !payload?.message) {
      return new Response(JSON.stringify({ error: "source, errorCode, message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
    const fp = fingerprint(payload);

    // Check for an existing unresolved alert with same fingerprint
    const { data: existing } = await supabase
      .from("system_alerts")
      .select("id, occurrence_count, email_sent, github_issue_url")
      .eq("fingerprint", fp)
      .eq("resolved", false)
      .maybeSingle();

    if (existing) {
      // Bump counter only — don't re-spam email/GitHub
      await supabase
        .from("system_alerts")
        .update({
          occurrence_count: (existing.occurrence_count ?? 1) + 1,
          last_seen_at: new Date().toISOString(),
          details: payload.details ?? {},
        })
        .eq("id", existing.id);

      return new Response(
        JSON.stringify({ ok: true, deduped: true, alert_id: existing.id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // First occurrence — insert, then notify
    const { data: inserted, error: insertError } = await supabase
      .from("system_alerts")
      .insert({
        severity: payload.severity ?? "critical",
        source: payload.source,
        error_code: payload.errorCode,
        message: payload.message,
        details: payload.details ?? {},
        fingerprint: fp,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("[report-critical-error] insert failed:", insertError);
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fan out: email + github (parallel, both best-effort)
    const [emailOk, ghResult] = await Promise.all([
      sendEmail(payload, 1),
      fileGithubIssue(payload),
    ]);

    await supabase
      .from("system_alerts")
      .update({
        email_sent: emailOk,
        email_sent_at: emailOk ? new Date().toISOString() : null,
        github_issue_url: ghResult.url,
        github_issue_number: ghResult.number,
      })
      .eq("id", inserted.id);

    return new Response(
      JSON.stringify({
        ok: true,
        alert_id: inserted.id,
        email_sent: emailOk,
        github_issue_url: ghResult.url,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[report-critical-error] unexpected:", err);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});