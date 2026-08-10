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
// verify_jwt = false: called by pg_net (a machine caller). It only manages a fixed set
// of BBQS groups and reads its Google creds from function secrets — not an open relay.
//
// Requires (KG project function secrets, same values the agent uses):
//   GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET · GOOGLE_REFRESH_TOKEN

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
// role → managed role-group keys (mirrors the agent's groupsForRole, minus consortium).
function roleSet(role: unknown): Set<string> {
  const r = String(role ?? "").toLowerCase().trim();
  const out = new Set<string>();
  // pi@ = the PI roles NIH actually records on the award. co-investigator sits on the award
  // but is NOT a PI for mailing-list purposes (policy 2026-08-07: "only people who can be
  // pulled out of RePORTER are PIs"). The broad rule had put 24 co-investigators on pi@.
  if (["pi", "contact_pi", "co_pi", "mpi"].includes(r)) out.add("pi");
  else if (r === "postdoc" || r === "graduate_student") out.add("young_investigators");
  else if (r === "nih_program") { out.add("dcaic_all"); out.add("nih"); }
  else if (r === "admin") out.add("dcaic_all");
  return out;
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

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!email) return json({ ok: true, skipped: "no email on record" });

    const oldWG = wgSet(body?.old?.working_groups);
    const newWG = wgSet(body?.new?.working_groups);
    const oldRole = roleSet(body?.old?.role);
    const newRole = roleSet(body?.new?.role);

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
