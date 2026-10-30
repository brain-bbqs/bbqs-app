// Weekly digest of stuck onboarding steps, emailed to the DCAIC admins.
//
// onboarding_pipeline already computes is_stuck, but nothing told anyone: it showed only when
// someone opened the admin panel. Suthana's Slack step sat stuck for 96 days that way. The cron
// in migration 20261029120000 calls this every Monday; a curator can pass {"dry_run": true}
// (bbqs MCP onboarding_digest) to see the same digest without sending it.
//
// Deploy: supabase functions deploy onboarding-stuck-digest  (needs RESEND_API_KEY).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bbqs-client",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FROM_RE = /^(?:[^<>]+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>|[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)$/;
const envAddr = (name: string, fallback: string) => {
  const v = (Deno.env.get(name) || "").trim();
  return FROM_RE.test(v) ? v : fallback;
};
const FROM_ADDRESS = envAddr("DIGEST_FROM", "BBQS <noreply@brain-bbqs.org>");
const DIGEST_TO = envAddr("DIGEST_TO", "dcaic-admin@brain-bbqs.org");
const CONSOLE_URL = "https://brain-bbqs.org/admin";

const OPEN = new Set(["not_started", "pending", "queued"]);
const STEP: Record<string, { label: string; next: string }> = {
  kg_created: { label: "KG profile", next: "onboard_member" },
  grant_link: { label: "Grant roster link", next: "onboard_member with the grant_id" },
  consortium_group: { label: "consortium@", next: "sync_member_groups, or group_audit repair" },
  pi_group: { label: "pi@", next: "link the roster first, then sync_member_groups" },
  young_investigators_group: { label: "young-investigators@", next: "sync_member_groups" },
  wg_groups: { label: "Working-group lists", next: "sync_member_groups" },
  welcome_email: { label: "Welcome email", next: "send_welcome_email" },
  data_questionnaire: { label: "Data questionnaire", next: "PI submits the form; then import_questionnaire_response" },
  slack: { label: "Slack", next: "slack_channels check (tries every address on file); a single-channel guest needs an account-type change in Slack" },
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const { dry_run } = await req.json().catch(() => ({}));

    // The cron authenticates with the service-role key (public.cron_invoke). Anyone else must be
    // a signed-in admin or curator.
    const fromCron = bearer !== "" && bearer === serviceKey;
    if (!fromCron) {
      const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      });
      const { data: u } = await caller.auth.getUser();
      if (!u?.user?.id) return json({ ok: false, error: "Not authenticated" }, 401);
      const { data: roles } = await caller.from("user_roles").select("role").eq("user_id", u.user.id);
      if (!(roles || []).some((r: { role: string }) => r.role === "admin" || r.role === "curator")) {
        return json({ ok: false, error: "Admin or curator only" }, 403);
      }
    }

    const db = createClient(url, serviceKey);
    const { data: rows, error } = await db.from("onboarding_pipeline")
      .select("id,name,email,role,checklist,days_since_created,steps_done,steps_total")
      .eq("is_stuck", true)
      .order("days_since_created", { ascending: false });
    if (error) return json({ ok: false, error: `onboarding_pipeline: ${error.message}` }, 500);

    const ids = (rows || []).map((r: { id: string }) => r.id);
    const grantsOf: Record<string, string[]> = {};
    if (ids.length) {
      const { data: gi } = await db.from("grant_investigators")
        .select("investigator_id,grants(grant_number)").in("investigator_id", ids);
      for (const g of (gi || []) as Array<{ investigator_id: string; grants: { grant_number: string } | null }>) {
        if (g.grants?.grant_number) (grantsOf[g.investigator_id] ??= []).push(g.grants.grant_number);
      }
    }

    const people = (rows || []).map((r: {
      id: string; name: string; email: string; role: string | null;
      checklist: Record<string, unknown> | null; days_since_created: number; steps_done: number; steps_total: number;
    }) => ({
      name: r.name,
      email: r.email,
      role: r.role,
      grants: (grantsOf[r.id] || []).sort(),
      days: r.days_since_created,
      progress: `${r.steps_done}/${r.steps_total}`,
      open: Object.entries(r.checklist || {})
        .filter(([, v]) => typeof v === "string" && OPEN.has(v))
        .map(([k]) => ({ step: k, label: STEP[k]?.label ?? k, next: STEP[k]?.next ?? "" })),
    }));

    const n = people.length;
    const subject = `BBQS onboarding: ${n} ${n === 1 ? "person" : "people"} stuck`;
    if (dry_run || n === 0) {
      return json({ ok: true, stuck: n, sent: false, ...(n === 0 ? { reason: "nobody is stuck" } : {}), subject, to: DIGEST_TO, people });
    }

    const rowsHtml = people.map((p) => `
      <tr>
        <td style="padding:6px 8px;vertical-align:top"><strong>${esc(p.name)}</strong><br><span style="color:#666">${esc(p.email)}</span></td>
        <td style="padding:6px 8px;vertical-align:top">${esc(p.grants.join(", ") || "—")}</td>
        <td style="padding:6px 8px;vertical-align:top;text-align:right">${esc(p.days)}</td>
        <td style="padding:6px 8px;vertical-align:top">${p.open.map((o) => `${esc(o.label)} <span style="color:#666">→ ${esc(o.next)}</span>`).join("<br>")}</td>
      </tr>`).join("");
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:820px">
        <p>${n} ${n === 1 ? "member is" : "members are"} flagged stuck by the onboarding pipeline. Each line lists the open steps and the bbqs MCP tool that unblocks them.</p>
        <table style="border-collapse:collapse;font-size:13px">
          <tr style="background:#f0f2f5;text-align:left">
            <th style="padding:6px 8px">Member</th><th style="padding:6px 8px">Grant(s)</th>
            <th style="padding:6px 8px">Days</th><th style="padding:6px 8px">Open steps → next</th>
          </tr>${rowsHtml}
        </table>
        <p style="font-size:13px;color:#666">Full pipeline: <a href="${CONSOLE_URL}">${CONSOLE_URL}</a>. Sent every Monday by onboarding-stuck-digest.</p>
      </div>`;
    const textBody = [
      `${n} member(s) flagged stuck by the onboarding pipeline.`, "",
      ...people.map((p) => `- ${p.name} <${p.email}> | ${p.grants.join(", ") || "no grant"} | ${p.days} days\n` +
        p.open.map((o) => `    ${o.label} -> ${o.next}`).join("\n")),
      "", `Full pipeline: ${CONSOLE_URL}`,
    ].join("\n");

    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return json({ ok: false, error: "RESEND_API_KEY not configured" }, 500);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [DIGEST_TO], subject, html, text: textBody }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ ok: false, error: data }, 502);
    return json({ ok: true, stuck: n, sent: true, to: DIGEST_TO, id: data.id, subject });
  } catch (e) {
    return json({ ok: false, error: `onboarding-stuck-digest: ${String((e as Error)?.message ?? e)}` }, 500);
  }
});
