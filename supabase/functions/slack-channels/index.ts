// Slack channel membership for the onboarding console (option A).
//
// Workspace ENTRY for an external guest cannot be automated (Slack requires a manual guest
// invite). Everything AFTER that can: once the person exists in the workspace we resolve them
// by email and add them to the configured onboarding channels. This function does exactly that
// — it never invites to the workspace, so an external guest who hasn't been invited yet is
// reported honestly instead of failing silently.
//
// Role→channel rule (mirrors the agent, src/server/onboarding/workflow.ts):
//   everyone            -> SLACK_ONBOARDING_CHANNELS
//   postdoc | grad stud -> + SLACK_YI_CHANNELS   (the young-investigator channel[s])
//
// Deploy: supabase functions deploy slack-channels
// Secrets: SLACK_BOT_TOKEN (bot scopes: users:read.email, channels:read, groups:read,
//          channels:manage/groups:write for conversations.invite),
//          SLACK_ONBOARDING_CHANNELS="C07UA8763SA,C0951JD5SAV,C096Q1GMU01,C07UGPTGCHH",
//          SLACK_YI_CHANNELS="C09673P9D1A"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const YI_ROLES = new Set(["postdoc", "graduate_student"]);
const csv = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function slack(method: string, token: string, params: Record<string, string>, post = false) {
  const url = `https://slack.com/api/${method}`;
  const res = post
    ? await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(params),
      })
    : await fetch(`${url}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { email, role, action } = await req.json().catch(() => ({}));
    if (!email || typeof email !== "string") return json({ ok: false, error: "Provide an email" }, 400);

    // Authz: admin/curator only, checked under the caller's own JWT.
    const authHeader = req.headers.get("Authorization") || "";
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await supa.auth.getUser();
    const uid = userData?.user?.id;
    if (!uid) return json({ ok: false, error: "Not authenticated" }, 401);
    const { data: roles } = await supa.from("user_roles").select("role").eq("user_id", uid);
    if (!(roles || []).some((r: { role: string }) => r.role === "admin" || r.role === "curator")) {
      return json({ ok: false, error: "Admin or curator only" }, 403);
    }

    // Report WHICH piece of config is missing (presence only — never the values), so a 500
    // explains itself instead of forcing a Network-tab dig.
    const token = Deno.env.get("SLACK_BOT_TOKEN");
    const base = csv(Deno.env.get("SLACK_ONBOARDING_CHANNELS"));
    const yi = csv(Deno.env.get("SLACK_YI_CHANNELS"));
    const cfg = { SLACK_BOT_TOKEN: !!token, SLACK_ONBOARDING_CHANNELS: base.length, SLACK_YI_CHANNELS: yi.length };

    // A secret pasted with a non-ASCII character (a smart quote, a curly apostrophe, or the
    // literal "…" from a docs placeholder) makes the Authorization header invalid and fetch
    // throws the opaque "not a valid ByteString". Catch it here and say exactly what is wrong,
    // without ever echoing the secret.
    const badChars = (v: string) => [...v].filter((c) => c.charCodeAt(0) > 126 || c.charCodeAt(0) < 32);
    if (token) {
      const bad = badChars(token);
      if (bad.length) {
        const codes = [...new Set(bad.map((c) => "U+" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")))];
        console.error("slack-channels: SLACK_BOT_TOKEN contains non-ASCII", codes);
        return json({
          ok: false,
          error: `SLACK_BOT_TOKEN contains ${bad.length} non-ASCII character(s) (${codes.join(", ")}) — it was probably pasted with a placeholder or a smart quote. Re-set it with the real token: supabase secrets set SLACK_BOT_TOKEN=xoxb-YOUR-REAL-TOKEN`,
        }, 500);
      }
      if (!token.startsWith("xox")) {
        return json({ ok: false, error: "SLACK_BOT_TOKEN does not look like a Slack bot token (expected it to start with 'xoxb-')." }, 500);
      }
    }
    const badChannel = [...base, ...yi].find((c) => badChars(c).length);
    if (badChannel) {
      return json({ ok: false, error: `A configured Slack channel ID contains non-ASCII characters. Re-set SLACK_ONBOARDING_CHANNELS / SLACK_YI_CHANNELS as plain comma-separated IDs (e.g. C07UA8763SA,C0951JD5SAV).` }, 500);
    }
    if (!token || !base.length) {
      console.error("slack-channels: missing config", cfg);
      return json({
        ok: false,
        config: cfg,
        error: `Slack is not configured on this project: ${!token ? "SLACK_BOT_TOKEN missing" : ""}${!token && !base.length ? "; " : ""}${!base.length ? "SLACK_ONBOARDING_CHANNELS missing" : ""}. Set them with: supabase secrets set SLACK_BOT_TOKEN=xoxb-… SLACK_ONBOARDING_CHANNELS="C…,C…"`,
      }, 500);
    }
    const isYI = YI_ROLES.has(String(role ?? "").toLowerCase());
    const target = [...new Set([...base, ...(isYI ? yi : [])])];

    // 1. Resolve the person in the workspace (external guests must be invited manually first).
    const lookup = await slack("users.lookupByEmail", token, { email: String(email).toLowerCase() });
    if (!lookup?.ok) {
      const err = String(lookup?.error ?? "unknown");
      if (err === "users_not_found") {
        return json({
          ok: false, not_in_workspace: true,
          error: `${email} is not in the Slack workspace yet — send them a Slack guest invite first, then run this again.`,
        });
      }
      return json({ ok: false, error: `Slack lookup failed: ${err}` }, 502);
    }
    const userId = lookup.user.id as string;

    // 2. Which of the target channels are they already in?
    const conv = await slack("users.conversations", token, {
      user: userId, types: "public_channel,private_channel", limit: "200", exclude_archived: "true",
    });
    const current: string[] = conv?.ok ? (conv.channels ?? []).map((c: { id: string }) => c.id) : [];
    const missing = target.filter((c) => !current.includes(c));

    if (action !== "invite") {
      return json({ ok: true, user_id: userId, is_young_investigator: isYI, target, in_channels: target.filter((c) => current.includes(c)), missing });
    }

    // 3. Add them to the channels they're missing.
    const invited: string[] = [];
    const failed: { channel: string; error: string }[] = [];
    for (const channel of missing) {
      const r = await slack("conversations.invite", token, { channel, users: userId }, true);
      if (r?.ok || r?.error === "already_in_channel") invited.push(channel);
      else failed.push({ channel, error: String(r?.error ?? "unknown") });
    }
    return json({
      ok: failed.length === 0,
      user_id: userId,
      is_young_investigator: isYI,
      invited,
      failed,
      already_in: target.filter((c) => current.includes(c)),
      error: failed.length ? `Could not add to ${failed.length} channel(s): ${failed.map((f) => `${f.channel} (${f.error})`).join(", ")}` : undefined,
    });
  } catch (e) {
    // Log the full error so it is visible in the function Logs, and return the message.
    console.error("slack-channels failed:", e);
    return json({ ok: false, error: `slack-channels: ${String((e as Error)?.message ?? e)}` }, 500);
  }
});
