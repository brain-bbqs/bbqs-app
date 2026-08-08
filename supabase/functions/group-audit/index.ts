// Audit ACTUAL Google Group membership against what the KG says it should be.
//
// Why this must exist: trg_sync_member_groups fires AFTER UPDATE only, and only when
// working_groups/role actually CHANGED. So anyone whose groups were loaded before that trigger
// existed (2026-07-22), or set at INSERT time, was NEVER synced — and pg_net delivery is
// fire-and-forget, so failures are silent. `investigators.working_groups` is therefore an
// INTENT record, not proof of membership. This reads live state from Google and diffs it.
//
// POST { action: "audit" }  -> per-group counts + the exact drift, writes nothing.
// POST { action: "repair" } -> adds the missing members (never removes; removals stay manual).
//
// Deploy: supabase functions deploy group-audit
// Needs the same secrets as sync-member-groups: GOOGLE_CLIENT_ID / _SECRET / _REFRESH_TOKEN.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// WG token -> group address. Role groups are audited separately from role.
const WG_GROUPS: Record<string, string> = {
  "WG-Analytics": "wg-analytics@brain-bbqs.org",
  "WG-Devices": "wg-devices@brain-bbqs.org",
  "WG-ELSI": "wg-elsi@brain-bbqs.org",
  "WG-Standards": "wg-standards@brain-bbqs.org",
};
const CONSORTIUM = "consortium@brain-bbqs.org";
const PI_GROUP = "pi@brain-bbqs.org";
const YI_GROUP = "young-investigators@brain-bbqs.org";
// PI = a PI role on the NIH GRANT ROSTER (grant_investigators), which is derived from NIH
// RePORTER. The self-reported investigators.role is NOT authority: 25 members type a PI-ish
// title on the onboarding form with no PI roster row at all, and that is how 24
// co-investigators ended up on pi@ (policy call, 2026-08-07: "only people who can be pulled
// out of RePORTER are PIs"). Roster 'co-investigator' does NOT qualify either.
const PI_ROSTER_ROLES = new Set(["pi", "contact_pi", "co_pi", "mpi"]);
const YI_ROLES = new Set(["postdoc", "graduate_student"]);

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth env vars");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`Google OAuth error: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Every member address of a group (paginated). */
async function listGroupMembers(group: string, token: string): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group)}/members`);
    u.searchParams.set("maxResults", "200");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`list ${group}: ${res.status} ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    for (const m of j.members ?? []) if (m.email) out.push(String(m.email).toLowerCase());
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

async function addMember(email: string, group: string, token: string): Promise<string | null> {
  const res = await fetch(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group)}/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, role: "MEMBER", type: "USER" }),
  });
  if (res.ok) return null;
  const t = await res.text();
  return t.includes("duplicate") || t.includes("Member already exists") ? null : `${res.status}: ${t.slice(0, 120)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { action } = await req.json().catch(() => ({}));
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

    // Service-role read: the audit must see EVERY investigator, not just RLS-visible ones.
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: people, error } = await admin
      .from("investigators")
      .select("id,name,email,secondary_emails,role,working_groups");
    if (error) throw new Error(error.message);

    // Authoritative PI set, straight from the grant roster.
    const { data: roster } = await admin.from("grant_investigators").select("investigator_id,role");
    const piIds = new Set(
      (roster ?? [])
        .filter((r: { role: string | null }) => PI_ROSTER_ROLES.has(String(r.role ?? "").toLowerCase()))
        .map((r: { investigator_id: string }) => r.investigator_id),
    );

    const token = await getAccessToken();
    const groups: Record<string, { expected: string[]; actual_count: number; missing: string[]; extra_count: number; extra?: string[] }> = {};

    // Build the expected membership per group from the KG.
    const expect: Record<string, Set<string>> = {};
    const add = (g: string, e: string) => { (expect[g] ??= new Set()).add(e.toLowerCase()); };
    for (const p of people ?? []) {
      const email = (p.email ?? "").toLowerCase().trim();
      if (!email) continue;
      const role = String(p.role ?? "").toLowerCase();
      add(CONSORTIUM, email);
      if (piIds.has(p.id)) add(PI_GROUP, email);   // roster-derived, never self-reported
      if (YI_ROLES.has(role)) add(YI_GROUP, email);
      for (const wg of p.working_groups ?? []) if (WG_GROUPS[wg]) add(WG_GROUPS[wg], email);
    }
    // Alternate addresses count as "already a member" — a person may be in a group under either.
    const alt: Record<string, string[]> = {};
    for (const p of people ?? []) {
      const email = (p.email ?? "").toLowerCase().trim();
      if (email) alt[email] = (p.secondary_emails ?? []).map((s: string) => s.toLowerCase());
    }

    let repaired = 0;
    const failures: string[] = [];
    for (const [group, wanted] of Object.entries(expect)) {
      const actual = new Set(await listGroupMembers(group, token));
      const missing = [...wanted].filter((e) => !actual.has(e) && !(alt[e] ?? []).some((a) => actual.has(a)));
      // EXTRA = in the Google Group but not entitled by the KG. Reported by ADDRESS (not just a
      // count) because that is the list an admin must act on — e.g. co-investigators sitting on
      // pi@. Never auto-removed: repair only adds.
      const entitled = new Set([...wanted, ...[...wanted].flatMap((e) => alt[e] ?? [])]);
      const extra = [...actual].filter((e) => !entitled.has(e));
      groups[group] = {
        expected: [],
        actual_count: actual.size,
        missing,
        extra_count: extra.length,
        extra,
      };
      if (action === "repair") {
        for (const e of missing) {
          const err = await addMember(e, group, token);
          if (err) failures.push(`${group} <- ${e}: ${err}`); else repaired++;
        }
      }
    }

    const summary = Object.fromEntries(Object.entries(groups).map(([g, v]) => [g, {
      expected: (expect[g] ?? new Set()).size, in_google: v.actual_count, missing: v.missing.length, extra: v.extra_count,
    }]));
    return json({
      ok: failures.length === 0,
      action: action === "repair" ? "repair" : "audit",
      summary,
      missing_by_group: Object.fromEntries(Object.entries(groups).map(([g, v]) => [g, v.missing])),
      extra_by_group: Object.fromEntries(Object.entries(groups).map(([g, v]) => [g, (v as { extra?: string[] }).extra ?? []])),
      repaired: action === "repair" ? repaired : undefined,
      failures: failures.length ? failures : undefined,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
