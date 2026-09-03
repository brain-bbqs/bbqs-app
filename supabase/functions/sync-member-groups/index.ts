// Sync a member's Google Group memberships when their KG profile changes.
//
// Invoked by the AFTER UPDATE trigger on public.investigators (migration
// 20260722_sync_member_groups_trigger.sql) whenever working_groups or role changes —
// no matter who made the edit (the member themselves, a curator/admin, or the agent).
// This gives profile edits on the KG site the SAME side-effects the onboarding agent
// produces, automatically ("as if the agent changed it").
//
// Reconciles by DELTA (old → new), so it only ever touches the groups that actually
// changed — a removed WG is removed, an added WG is added, and a role change moves the
// person between role groups. consortium@ is always ensured and never removed.
//
// verify_jwt = false, but the handler authenticates EVERY caller itself (see the gate at the
// top of Deno.serve) — this function makes privileged Google Directory writes, so it must not be
// an open relay. Two callers are honoured, everything else is 401/403:
//   1. The service-role key in Authorization. This is what the trg_sync_member_groups trigger
//      sends: it posts via public.cron_invoke, which pulls the service-role key from the vault
//      and puts it in Authorization (migration 20260903120000). Manual cron_invoke matches too.
//      Same branch as reporter-pi-sync.
//   2. A signed-in admin/curator, by their forwarded JWT — the Admin Console (ResolveStageDialog)
//      and the bbqs-mcp sync_member_groups tool. Same has_role check as slack-channels.
// The PUBLIC anon key alone is rejected: it is embedded in the browser client, so accepting it
// would leave these Directory writes open to anyone who can reach the URL.
//
// Requires (KG project function secrets, same values the agent uses):
//   GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET · GOOGLE_REFRESH_TOKEN
import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GROUPS: Record<string, string> = {
  consortium: "consortium@brain-bbqs.org",
  pi: "pi@brain-bbqs.org",
  dcaic_all: "dcaic-all@brain-bbqs.org",
  nih: "nih@brain-bbqs.org",
  young_investigators: "young-investigators@brain-bbqs.org",
  wg_analytics: "wg-analytics@brain-bbqs.org",
  wg_devices: "wg-devices@brain-bbqs.org",
  wg_elsi: "wg-elsi@brain-bbqs.org",
  wg_standards: "wg-standards@brain-bbqs.org",
};
const WG_KEYS = ["wg_analytics", "wg_devices", "wg_elsi", "wg_standards"];
// Role-driven groups this function is allowed to add/remove (consortium is separate —
// always ensured, never removed).
const ROLE_KEYS = ["pi", "young_investigators", "dcaic_all", "nih"];

// Free-text WG name → group key (mirrors the agent's normaliseWG). Handles "Analytics",
// "WG-Analytics", "ELSI", "Ethics", etc.
function normaliseWG(raw: string): string | null {
  const s = (raw ?? "").toLowerCase().trim();
  if (s.includes("analyt")) return "wg_analytics";
  if (s.includes("device")) return "wg_devices";
  if (s.includes("elsi") || s.includes("ethic")) return "wg_elsi";
  if (s.includes("standard")) return "wg_standards";
  return null;
}
function wgSet(arr: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(arr)) for (const v of arr) { const k = normaliseWG(String(v)); if (k) out.add(k); }
  return out;
}
/** PI roles as NIH records them on the award. co-investigator sits on the award but is NOT a PI for
 *  mailing-list purposes (policy 2026-08-07: "only people who can be pulled out of RePORTER are
 *  PIs"). The broad rule had put 24 co-investigators on pi@. */
const PI_ROSTER_ROLES = new Set(["pi", "contact_pi", "co_pi", "mpi"]);

/** Career-stage groups, derived from the free-text investigators.role.
 *
 *  MATCH BY SUBSTRING, not equality. investigators.role holds RAW Google-Form labels, not canonical
 *  tokens: "Postdoc/Grad Student" (32 people), "Research Staff (Scientist and others)" (27),
 *  "Principal Investigator (PI)" (38), plus free text and 68 NULLs. Exact matching saw almost none of
 *  them — the same mistake that made group-audit flag 66 real trainees as removable (2026-08-07).
 *  young-investigators@ is for postdocs and PhD students (policy 2026-08-10). */
function careerGroupSet(role: unknown): Set<string> {
  const r = String(role ?? "").toLowerCase().trim();
  const out = new Set<string>();
  if (!r) return out;
  if (/post-?doc|grad(uate)?\s*student|\bgrad\b|trainee|student|ph\.?\s?d/.test(r)) {
    out.add("young_investigators");
  }
  if (/nih\s*program/.test(r)) { out.add("dcaic_all"); out.add("nih"); }
  else if (/^admin$/.test(r)) out.add("dcaic_all");
  return out;
}

/** Is this person a PI on ANY grant, per the roster? THE source of truth for pi@.
 *
 *  Previously pi@ was decided by exact-matching investigators.role against canonical tokens, but that
 *  column overwhelmingly holds human form labels. Measured 2026-08-11: 74 investigators hold a PI
 *  role on the grant roster, while only 9 had a canonical token in investigators.role — so this
 *  trigger MISSED 65 real PIs, and the only 9 it caught were the ones onboard_member happened to
 *  write a token for. Meanwhile group-audit computed the expected pi@ set from the roster, so the two
 *  surfaces disagreed about who belongs and the audit reported permanent drift.
 *
 *  The roster is RePORTER-derived and per-grant, which is what "PI" actually means; a single
 *  self-reported scalar cannot express it. Read it directly and stop inferring. */
async function isRosterPi(supabaseUrl: string, serviceKey: string, email: string): Promise<boolean> {
  const url =
    `${supabaseUrl}/rest/v1/grant_investigators` +
    `?select=role,investigators!inner(email,secondary_emails)` +
    `&investigators.email=eq.${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!res.ok) {
    // Fail CLOSED for additions: better to leave pi@ unchanged than to guess from a stale label.
    console.error(`isRosterPi lookup failed (${res.status}) for ${email}`);
    return false;
  }
  const rows = (await res.json()) as Array<{ role: string | null }>;
  return rows.some((r) => PI_ROSTER_ROLES.has(String(r.role ?? "").toLowerCase().trim()));
}

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Google OAuth env vars (GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN)");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth token error: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function addMember(email: string, group: string, token: string): Promise<string | null> {
  const res = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group)}/members`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, role: "MEMBER", type: "USER" }),
    },
  );
  if (res.ok || res.status === 409) return null; // 409 = already a member (idempotent)
  return `add ${group}: ${res.status} ${(await res.text()).slice(0, 120)}`;
}

async function removeMember(email: string, group: string, token: string): Promise<string | null> {
  const res = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(email)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.ok || res.status === 404) return null; // 404 = not a member (idempotent)
  return `remove ${group}: ${res.status} ${(await res.text()).slice(0, 120)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // ── Caller authentication ────────────────────────────────────────────────────────────────
  // Gate before any privileged work. A service-role bearer is a trusted machine caller (the
  // trigger, via cron_invoke, and manual cron_invoke) — same branch as reporter-pi-sync. Otherwise
  // the caller must be a signed-in admin/curator, checked under their own forwarded JWT — the
  // pattern slack-channels uses. Anything else (including the public anon key) is rejected.
  const authHeader = req.headers.get("Authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const isServiceRole = bearer.length > 0 && bearer === serviceKey;
  if (!isServiceRole) {
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await asUser.auth.getUser();
    const uid = userData?.user?.id;
    if (!uid) return json({ ok: false, error: "Not authenticated — sign in as an admin/curator, or call with the service role key" }, 401);
    const { data: roles } = await asUser.from("user_roles").select("role").eq("user_id", uid);
    if (!(roles ?? []).some((r: { role: string }) => r.role === "admin" || r.role === "curator")) {
      return json({ ok: false, error: "Admin or curator only" }, 403);
    }
  }

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!email) return json({ ok: true, skipped: "no email on record" });

    const oldWG = wgSet(body?.old?.working_groups);
    const newWG = wgSet(body?.new?.working_groups);
    // Career-stage groups still diff off the label, because that is where career stage lives.
    const oldRole = careerGroupSet(body?.old?.role);
    const newRole = careerGroupSet(body?.new?.role);

    const toAdd = new Set<string>();
    const toRemove = new Set<string>();
    for (const k of WG_KEYS) {
      if (newWG.has(k) && !oldWG.has(k)) toAdd.add(k);
      if (oldWG.has(k) && !newWG.has(k)) toRemove.add(k);
    }
    for (const k of ROLE_KEYS) {
      if (newRole.has(k) && !oldRole.has(k)) toAdd.add(k);
      if (oldRole.has(k) && !newRole.has(k)) toRemove.add(k);
    }

    // pi@ is ENSURED from the roster and never revoked here. A label edit is not evidence that
    // someone stopped being a PI on their award, and this trigger cannot see the roster change that
    // would be — removal belongs to offboarding and to the explicit group audit.
    const svcUrl = Deno.env.get("SUPABASE_URL");
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (svcUrl && svcKey && (await isRosterPi(svcUrl, svcKey, email))) {
      toAdd.add("pi");
      toRemove.delete("pi");
    }

    const token = await getAccessToken();
    const errors: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];

    // consortium is always ensured (idempotent) and never removed.
    await addMember(email, GROUPS.consortium, token);

    for (const k of toAdd) {
      const err = await addMember(email, GROUPS[k], token);
      if (err) errors.push(err); else added.push(k);
    }
    for (const k of toRemove) {
      const err = await removeMember(email, GROUPS[k], token);
      if (err) errors.push(err); else removed.push(k);
    }

    console.log(`[sync-member-groups] ${email} +[${added}] -[${removed}] ${errors.length ? "errors:" + errors.join("; ") : ""}`);
    return json({ ok: errors.length === 0, email, added, removed, errors });
  } catch (e) {
    console.error("[sync-member-groups] error:", e instanceof Error ? e.message : String(e));
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
