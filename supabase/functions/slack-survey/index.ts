// Survey live Slack channel membership and record who is missing, bucketed by channel.
//
// WHY A SURVEY RATHER THAN AN INVITE ATTEMPT. Slack refuses to let a BOT add a guest to a channel —
// admin-only, and no bot scope changes that. Working-group choices arrive later, from the member, on
// the site. So the add cannot be automated, but the DETECTION can, continuously. This function does the
// detection and records the gap; a human clears it with one paste per channel.
//
// The old behaviour attempted the add, got user_is_restricted, reported "Could not add to 2 channel(s)"
// and DISCARDED which channels were wanted — so the same failure recurred on every retry and nothing
// accumulated. Here the intent is persisted with an age, so a name waiting three weeks is visibly
// different from one that appeared this morning.
//
// POST { action: "survey" }   -> read live membership, refresh the snapshot, upsert/resolve the backlog
// POST { action: "backlog" }  -> return the current backlog without touching Slack (cheap, for the UI)
//
// Deploy: supabase functions deploy slack-survey
// Secrets: SLACK_BOT_TOKEN (scopes: channels:read, groups:read, users:read, users:read.email)
// Cron:    select cron.schedule('slack-survey','0 7 * * *', $$ ... net.http_post ... $$);
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SLACK = "https://slack.com/api";

async function slack(method: string, token: string, params: Record<string, string> = {}) {
  const u = new URL(`${SLACK}/${method}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (!j.ok) throw new Error(`slack ${method}: ${j.error}`);
  return j;
}

/** Every workspace user, id -> { email, deleted, is_restricted, is_ultra_restricted }.
 *  One users.list beats a users.info per channel member: a 300-member workspace across six channels
 *  would otherwise be ~1000 calls and hit Slack's tier-3 rate limit. */
async function userIndex(token: string) {
  const byId = new Map<string, { email: string | null; guest: "none" | "multi" | "single"; deleted: boolean }>();
  let cursor = "";
  do {
    const j = await slack("users.list", token, { limit: "200", ...(cursor ? { cursor } : {}) });
    for (const m of j.members ?? []) {
      byId.set(m.id, {
        email: (m.profile?.email ?? null)?.toLowerCase() ?? null,
        guest: m.is_ultra_restricted ? "single" : m.is_restricted ? "multi" : "none",
        deleted: !!m.deleted,
      });
    }
    cursor = j.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return byId;
}

async function channelMemberIds(channel: string, token: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = "";
  do {
    const j = await slack("conversations.members", token, { channel, limit: "200", ...(cursor ? { cursor } : {}) });
    out.push(...(j.members ?? []));
    cursor = j.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { action = "survey" } = await req.json().catch(() => ({}));
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (action === "backlog") {
      const { data, error } = await admin.from("slack_channel_backlog").select("*");
      if (error) throw new Error(error.message);
      return json({ ok: true, backlog: data ?? [] });
    }

    const token = Deno.env.get("SLACK_BOT_TOKEN");
    if (!token) return json({ ok: false, error: "SLACK_BOT_TOKEN not configured" }, 500);
    // Non-ASCII here means the token was copied from a masked field (confirmed 2026-08-07: 19 U+2022
    // bullet characters). Say so precisely rather than failing with an opaque invalid_auth.
    const nonAscii = [...token].filter((c) => c.charCodeAt(0) > 127);
    if (nonAscii.length) {
      const points = [...new Set(nonAscii.map((c) => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`))];
      return json({
        ok: false,
        error: `SLACK_BOT_TOKEN contains ${nonAscii.length} non-ASCII character(s) (${points.join(", ")}) — it was probably copied from a masked field. Re-copy it from Slack → Your apps → OAuth & Permissions.`,
      }, 500);
    }

    const { data: channels, error: chErr } = await admin
      .from("slack_channels").select("channel_id, channel_name").eq("active", true);
    if (chErr) throw new Error(chErr.message);

    const users = await userIndex(token);
    const emailFor = (id: string) => {
      const u = users.get(id);
      return u && !u.deleted ? u.email : null;
    };

    const surveyed: Array<{ channel: string; live: number; expected: number; missing: number }> = [];
    const failures: string[] = [];

    for (const c of channels ?? []) {
      let liveEmails: string[];
      try {
        liveEmails = (await channelMemberIds(c.channel_id, token))
          .map(emailFor).filter((e): e is string => !!e);
      } catch (e) {
        // A channel the bot is not in cannot be surveyed. Report it; do NOT treat an unreadable
        // channel as empty, which would declare every expected member missing and produce a backlog
        // of hundreds out of a permissions problem.
        failures.push(`${c.channel_name}: ${(e as Error).message} — /invite @BBQS to that channel`);
        continue;
      }

      // Replace the snapshot for this channel.
      await admin.from("slack_channel_members").delete().eq("channel_id", c.channel_id);
      if (liveEmails.length) {
        await admin.from("slack_channel_members").insert(
          liveEmails.map((email) => ({ channel_id: c.channel_id, email })),
        );
      }

      const { data: expected } = await admin
        .from("slack_channel_expected").select("email").eq("channel_id", c.channel_id);
      const live = new Set(liveEmails);
      const missing = [...new Set((expected ?? []).map((e) => e.email))].filter((e) => !live.has(e));

      const now = new Date().toISOString();
      if (missing.length) {
        // Upsert keeps first_seen_at from the earliest survey that saw the gap; last_seen_at moves.
        await admin.from("slack_channel_pending").upsert(
          missing.map((email) => ({ channel_id: c.channel_id, email, last_seen_at: now, resolved_at: null })),
          { onConflict: "channel_id,email", ignoreDuplicates: false },
        );
      }
      // Anyone previously pending who is now in the channel is resolved — including people an admin
      // added by hand, which is the whole point: the backlog empties itself once the click happens.
      const stillMissing = new Set(missing);
      const { data: openRows } = await admin
        .from("slack_channel_pending").select("email")
        .eq("channel_id", c.channel_id).is("resolved_at", null);
      const resolved = (openRows ?? []).map((r) => r.email).filter((e) => !stillMissing.has(e));
      if (resolved.length) {
        await admin.from("slack_channel_pending")
          .update({ resolved_at: now })
          .eq("channel_id", c.channel_id).in("email", resolved);
      }

      surveyed.push({
        channel: c.channel_name,
        live: liveEmails.length,
        expected: new Set((expected ?? []).map((e) => e.email)).size,
        missing: missing.length,
      });
    }

    const { data: backlog } = await admin.from("slack_channel_backlog").select("*");
    return json({
      ok: failures.length === 0,
      surveyed,
      backlog: backlog ?? [],
      // Guest counts decide the strategic question: guests need an admin click forever, Members do not.
      guests: {
        single_channel: [...users.values()].filter((u) => !u.deleted && u.guest === "single").length,
        multi_channel: [...users.values()].filter((u) => !u.deleted && u.guest === "multi").length,
        members: [...users.values()].filter((u) => !u.deleted && u.guest === "none").length,
      },
      failures: failures.length ? failures : undefined,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
