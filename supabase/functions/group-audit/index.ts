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
// ADDITIVE-ONLY groups: the KG decides who gets INVITED, never who gets REVOKED. Unentitled
// members are reported but NEVER proposed for removal, and remove_extra refuses outright.
//
// Policy call 2026-08-10: "Young Investigator is only for postdocs and Ph.D. students. Scientists
// and others should be removed from such a suggestion. Leave anyone who is in the Young
// Investigator currently intact." So the entitlement rule stays strict on the ADD side —
// isYoungInvestigator does not match "Research Staff (Scientist and others)" — while existing
// membership is left alone.
//
// The distinction that matters is authority vs community. pi@ is an AUTHORITY list: being wrongly
// on it misrepresents who speaks for a project, which is why 24 non-PIs were removed from it
// (2026-08-07). young-investigators@ is a career-development COMMUNITY: someone may be there
// because a PI asked for them, because they mentor the group, or because they were early-career
// when they joined. None of that is legible to the KG, and removing them protects nothing.
// Meaghan Perdue (role "Admin") is the worked example — she works WITH the young investigators,
// a fact no role label encodes.
const ADDITIVE_ONLY_GROUPS = new Set([YI_GROUP]);
// investigators.role holds RAW Google-Form labels, not canonical tokens: "Postdoc/Grad Student"
// (33 people), "Principal Investigator (PI)", "Research Staff (Scientist and others), Postdoc",
// "Grad Student", free text, and 75 NULLs. An exact-match test saw only the 6 rows literally
// equal to "postdoc" and flagged 66 REAL trainees as removable (caught before anyone acted on
// it, 2026-08-07). Match by substring, the way the agent's normalizeRole does.
function isYoungInvestigator(role: string | null | undefined): boolean {
  const r = String(role ?? "").toLowerCase();
  if (!r) return false;
  // Policy (2026-08-10): young-investigators@ is for POSTDOCS AND PhD STUDENTS. "Research Staff
  // (Scientist and others)" is deliberately NOT entitled -- see ADDITIVE_ONLY_GROUPS for why that
  // does NOT make them removable. ph\.?\s?d catches "PhD candidate" labels that never say student.
  return /post-?doc|grad(uate)?\s*student|\bgrad\b|trainee|student|ph\.?\s?d/.test(r);
}
/** True when we cannot classify the role at all — such a member is never proposed for removal. */
function roleIsUnknown(role: string | null | undefined): boolean {
  const r = String(role ?? "").trim();
  if (!r) return true;
  return !/post-?doc|grad|student|trainee|principal|\bpi\b|co-?investigator|contact_pi|co_pi|mpi|research\s*staff|scientist|data\s*manager|project\s*manager|nih|admin/i.test(r);
}

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
async function listGroupMembers(group: string, token: string): Promise<Array<{ email: string; role: string }>> {
  const out: Array<{ email: string; role: string }> = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group)}/members`);
    u.searchParams.set("maxResults", "200");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`list ${group}: ${res.status} ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    for (const m of j.members ?? []) if (m.email) out.push({ email: String(m.email).toLowerCase(), role: String(m.role ?? "MEMBER").toUpperCase() });
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

async function removeMember(email: string, group: string, token: string): Promise<string | null> {
  const res = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(email)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.ok || res.status === 404) return null;   // 404 = already gone
  return `${res.status}: ${(await res.text()).slice(0, 120)}`;
}

/** Result of an add attempt. `already` is NOT success: Google resolved the address to an identity
 *  that is ALREADY a member under a DIFFERENT stored address, so nothing changed and the audit will
 *  propose the same address again next run. Reporting that as "added" is what made Repair claim
 *  progress forever on niegil.francis@nyu.edu -- Google resolves it to member id
 *  114753211097378846591 whose stored email is nm4075@nyu.edu, so the POST 409s and members.list
 *  never gains the alias. `storedEmail` is what Google actually has, so the caller can record it. */
type AddResult = { added: boolean; already: boolean; storedEmail?: string; error?: string };

/** Ask Google which address it actually stores for this member, so an alias can be recorded. */
async function storedEmailFor(email: string, group: string, token: string): Promise<string | undefined> {
  const res = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return undefined;
  const j = await res.json();
  const stored = String(j?.email ?? "").toLowerCase();
  return stored && stored !== email.toLowerCase() ? stored : undefined;
}

async function addMember(email: string, group: string, token: string): Promise<AddResult> {
  const res = await fetch(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group)}/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, role: "MEMBER", type: "USER" }),
  });
  if (res.ok) return { added: true, already: false };
  const t = await res.text();
  if (res.status === 409 || t.includes("duplicate") || t.includes("Member already exists")) {
    // Same identity, different address. Nothing was added; tell the truth and hand back the address
    // Google stores so the caller can record it as an alias and stop re-proposing this one.
    return { added: false, already: true, storedEmail: await storedEmailFor(email, group, token) };
  }
  // Google returns 404 "Resource Not Found: <email>" when the ADDRESS cannot be added — it is
  // not a real account and the group does not accept it. That is a DATA problem (a typo, or a
  // leftover test fixture in investigators), not a sync failure, so say so.
  if (res.status === 404) {
    return { added: false, already: false, error: `${email} could not be added — Google does not recognise that address. Check it is a real, current address (leftover test records are a common cause).` };
  }
  if (res.status === 403) {
    return { added: false, already: false, error: `${email}: permission denied by Google (the group may not allow external members).` };
  }
  return { added: false, already: false, error: `${email}: ${res.status} ${t.slice(0, 100)}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { action, group: bodyGroup, email: bodyEmail, groups: bodyGroups } = await req.json().catch(() => ({}));
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

    // OFFBOARD REMOVAL: remove ONE named member from an explicit list of groups, as computed by
    // the offboard_member RPC. Separate from the audit sweep — the caller states exactly who and
    // which groups, so nothing is inferred. Still skips OWNER/MANAGER (removing an owner can
    // break the group).
    if (action === "remove_groups") {
      const em = String(bodyEmail ?? "").toLowerCase().trim();
      const list = Array.isArray(bodyGroups) ? bodyGroups.map((g: unknown) => String(g).toLowerCase().trim()).filter(Boolean) : [];
      if (!em || !list.length) return json({ ok: false, error: "Provide email and groups[]" }, 400);
      const tok = await getAccessToken();
      const removedFrom: string[] = [];
      const skipped: string[] = [];
      const errs: string[] = [];
      for (const g of list) {
        try {
          const rows = await listGroupMembers(g, tok);
          const hit = rows.find((r) => r.email === em);
          if (!hit) { skipped.push(`${g} (not a member)`); continue; }
          if (hit.role !== "MEMBER") { skipped.push(`${g} (${hit.role} — not removed)`); continue; }
          const err = await removeMember(em, g, tok);
          if (err) errs.push(`${g}: ${err}`); else removedFrom.push(g);
        } catch (e) {
          errs.push(`${g}: ${String((e as Error)?.message ?? e)}`);
        }
      }
      return json({ ok: errs.length === 0, email: em, removed_from: removedFrom, skipped,
                    error: errs.length ? errs.join("; ") : undefined });
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

    // Admin judgements that a flagged member may stay (migration 20260810150000). Keyed
    // "<group>|<member>", valued by the role stamped at dismissal: the entry stays silenced only
    // while the KG still describes the person that way, because the judgement was made about that
    // description. A role change resurfaces it rather than muting it forever.
    const dismissed = new Map<string, string>();
    {
      const { data: rows, error: dErr } = await admin
        .from("group_audit_dismissals")
        .select("group_email,member_email,role_at_dismissal");
      // Degrade gracefully: if the migration has not been applied yet, audit as before.
      if (!dErr) {
        for (const r of rows ?? []) {
          dismissed.set(
            `${String(r.group_email).toLowerCase()}|${String(r.member_email).toLowerCase()}`,
            String(r.role_at_dismissal ?? ""),
          );
        }
      }
    }
    const roleForAddress = new Map<string, string>();
    for (const p of people ?? []) {
      const r = String(p.role ?? "");
      const e = (p.email ?? "").toLowerCase().trim();
      if (e) roleForAddress.set(e, r);
      for (const sx of p.secondary_emails ?? []) roleForAddress.set(String(sx).toLowerCase(), r);
    }
    /** Dismissed AND the role is unchanged since the dismissal was recorded. */
    const isDismissed = (group: string, email: string): boolean => {
      const key = `${group.toLowerCase()}|${email.toLowerCase()}`;
      if (!dismissed.has(key)) return false;
      return (roleForAddress.get(email.toLowerCase()) ?? "") === (dismissed.get(key) ?? "");
    };

    const token = await getAccessToken();
    const groups: Record<string, { expected: string[]; actual_count: number; missing: string[]; extra_count: number; extra?: string[]; extra_protected?: string[]; extra_dismissed?: string[] }> = {};

    // Build the expected membership per group from the KG.
    const expect: Record<string, Set<string>> = {};
    const add = (g: string, e: string) => { (expect[g] ??= new Set()).add(e.toLowerCase()); };
    for (const p of people ?? []) {
      const email = (p.email ?? "").toLowerCase().trim();
      if (!email) continue;
      const role = String(p.role ?? "").toLowerCase();
      add(CONSORTIUM, email);
      if (piIds.has(p.id)) add(PI_GROUP, email);   // roster-derived, never self-reported
      if (isYoungInvestigator(role)) add(YI_GROUP, email);
      for (const wg of p.working_groups ?? []) if (WG_GROUPS[wg]) add(WG_GROUPS[wg], email);
    }
    // Every address the KG knows about (primary + secondary). Used to guarantee removals only
    // ever touch real consortium members, never service accounts or nested groups.
    const knownMembers = new Set<string>();
    const unknownRole = new Set<string>();
    for (const p of people ?? []) {
      const e = (p.email ?? "").toLowerCase().trim();
      if (e) knownMembers.add(e);
      for (const sx of p.secondary_emails ?? []) knownMembers.add(String(sx).toLowerCase());
      if (roleIsUnknown(p.role)) {
        if (e) unknownRole.add(e);
        for (const sx of p.secondary_emails ?? []) unknownRole.add(String(sx).toLowerCase());
      }
    }

    // Alternate addresses count as "already a member" — a person may be in a group under either.
    const alt: Record<string, string[]> = {};
    for (const p of people ?? []) {
      const email = (p.email ?? "").toLowerCase().trim();
      if (email) alt[email] = (p.secondary_emails ?? []).map((s: string) => s.toLowerCase());
    }

    let repaired = 0;

    const alreadyMember: string[] = [];

    const aliasesLearned: string[] = [];
    let removed = 0;
    const failures: string[] = [];
    // Removal is scoped to ONE named group per call — never "clean every group" in one shot.
    const targetGroup = typeof bodyGroup === "string" ? bodyGroup.toLowerCase().trim() : "";
    for (const [group, wanted] of Object.entries(expect)) {
      const actualRows = await listGroupMembers(group, token);
      const actual = new Set(actualRows.map((r) => r.email));
      const roleOf = new Map(actualRows.map((r) => [r.email, r.role]));
      const missing = [...wanted].filter((e) => !actual.has(e) && !(alt[e] ?? []).some((a) => actual.has(a)));
      // EXTRA = in the Google Group but not entitled by the KG. Reported by ADDRESS (not just a
      // count) because that is the list an admin must act on — e.g. co-investigators sitting on
      // pi@. Never auto-removed: repair only adds.
      const entitled = new Set([...wanted, ...[...wanted].flatMap((e) => alt[e] ?? [])]);
      // SAFETY: only ever propose removing addresses that belong to a KNOWN investigator.
      // Anything else in the group — admin@/noreply@ service accounts, nested groups, external
      // collaborators — is left strictly alone, and OWNER/MANAGER is never touched (removing an
      // owner can break the group).
      // FAIL SAFE: only propose removal when the member's role is classifiable. An
      // unrecognized/blank role means we cannot prove they are NOT entitled, so they are
      // protected rather than removed.
      const removable = [...actual].filter(
        (e) => !entitled.has(e) && knownMembers.has(e) && roleOf.get(e) === "MEMBER" && !unknownRole.has(e),
      );
      // Dismissed entries drop out of the review list AND out of everything remove_extra iterates,
      // so "Remove N" can never sweep up a member an admin explicitly kept. An additive-only group
      // proposes nothing at all: its unentitled members are reported under extra_protected.
      const additiveOnly = ADDITIVE_ONLY_GROUPS.has(group);
      const extra = additiveOnly ? [] : removable.filter((e) => !isDismissed(group, e));
      const extraDismissed = additiveOnly ? [] : removable.filter((e) => isDismissed(group, e));
      const extraProtected = additiveOnly
        ? [...actual].filter((e) => !entitled.has(e))
        : [...actual].filter(
            (e) => !entitled.has(e) && (!knownMembers.has(e) || roleOf.get(e) !== "MEMBER" || unknownRole.has(e)),
          );
      groups[group] = {
        expected: [],
        actual_count: actual.size,
        missing,
        extra_count: extra.length,
        extra,
        extra_protected: extraProtected,
        extra_dismissed: extraDismissed,
      };
      if (action === "remove_extra" && targetGroup && group === targetGroup && additiveOnly) {
        // Refuse loudly. `extra` is already empty here, so the loop below would silently report
        // "removed 0" and look like a no-op bug rather than a policy.
        return json({
          ok: false,
          error: `${group} is additive-only: membership is never revoked by the audit, only proposed for addition. Remove someone from this group directly in Google if that is really intended.`,
        });
      }
      if (action === "remove_extra" && targetGroup && group === targetGroup) {
        for (const e of extra) {
          const err = await removeMember(e, group, token);
          if (err) failures.push(`${group} x ${e}: ${err}`); else removed++;
        }
      }
      if (action === "repair") {
        for (const e of missing) {
          const r = await addMember(e, group, token);
          if (r.error) { failures.push(`${group} <- ${e}: ${r.error}`); continue; }
          if (r.added) { repaired++; continue; }
          // ALREADY a member under a different stored address. Count it separately -- calling this
          // "added" is what let Repair report progress forever without changing anything. Then LEARN
          // the alias from Google so the audit stops proposing this address at all: recording it in
          // secondary_emails is exactly what the alt-address matching above already consumes.
          alreadyMember.push(`${group}: ${e} is already a member as ${r.storedEmail ?? "another address"}`);
          if (r.storedEmail) {
            const { error: aliasErr } = await admin.rpc("record_investigator_alias", {
              _primary_email: e,
              _alias: r.storedEmail,
            });
            if (aliasErr) failures.push(`${group} <- ${e}: alias not recorded (${aliasErr.message})`);
            else aliasesLearned.push(`${e} -> ${r.storedEmail}`);
          }
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
      dismissed_by_group: Object.fromEntries(
        Object.entries(groups).map(([g, v]) => [g, (v as { extra_dismissed?: string[] }).extra_dismissed ?? []]),
      ),
      // In the group, not KG-entitled, and deliberately NOT proposed for removal — service
      // accounts, nested groups, owners/managers, unclassifiable roles, and every member of an
      // additive-only group. Returned so these are VISIBLE: young-investigators@ carries 24
      // addresses with no KG record at all, which the audit previously computed and then dropped
      // on the floor, so they looked like they did not exist.
      protected_by_group: Object.fromEntries(
        Object.entries(groups).map(([g, v]) => [g, (v as { extra_protected?: string[] }).extra_protected ?? []]),
      ),
      additive_only_groups: [...ADDITIVE_ONLY_GROUPS],
      repaired: action === "repair" ? repaired : undefined,
      // Reported separately from `repaired` so "added N" can never again mean "changed nothing".
      already_member: action === "repair" && alreadyMember.length ? alreadyMember : undefined,
      aliases_learned: action === "repair" && aliasesLearned.length ? aliasesLearned : undefined,
      removed: action === "remove_extra" ? removed : undefined,
      removed_from: action === "remove_extra" ? targetGroup : undefined,
      failures: failures.length ? failures : undefined,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
