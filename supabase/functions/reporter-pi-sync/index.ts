// The PI roster, determined from NIH RePORTER, in temporal order.
//
// REQUEST (Satra, 2026-08-26): "all pis should be determined from reporter for a project as the
// authoritative source... the set of mpis from reporter could change over time, so all versions of a
// project should be inspected in temporal order to determine current PIs. (more generally this kind
// of workflow should be automated as a function talking to the reporter API) producing/updating a
// primary ground truth data file."
//
// WHAT THIS FIXES IN `nih-grants` reconcile, which it does not replace but supersedes for PIs:
//
//   1. HARDCODED GRANT LIST. That function carries 29 award numbers in an array; the KG holds 31
//      grants. R61MH138967 and U01MH144347 have therefore never been reconciled by the weekly cron.
//      This one reads `grants` — the live record decides, not a literal (Principle III).
//   2. ONE ARBITRARY BUDGET YEAR. It asks RePORTER for `limit: 1`. RePORTER returns one row per
//      FISCAL YEAR and the PI list belongs to the year, so that is a coin flip written over the
//      roster. This walks every year, oldest to newest, and stores each.
//   3. NAME MATCHING, WHICH SILENTLY DROPS PEOPLE. It does `ilike(name)` and `if (!inv) continue` —
//      a PI RePORTER lists but whose name is spelled differently here is skipped with no report.
//      RePORTER carries a stable `profile_id` per person; that is the anchor used here.
//
// MEASURED (2026-08-26, 31 projects / 57 project-years): one project has drifted, and it is a
// contact-PI handover — R61MH135405 FY2024 contact Joshua Jacobs, FY2025+ contact Brett Youngerman,
// same four PIs throughout. Precisely the bit a latest-row-wins sync flips depending on which year
// it happened to read.
//
// co_pi vs mpi: RePORTER draws exactly ONE distinction, `is_contact_pi`. Everything else is a PI.
// So `contact_pi` / `co_pi` is the whole vocabulary this function can honestly produce, which is
// also what Satra asked for.
//
// SAFETY. `snapshot`, `truth`, `link` and `drift` never touch grant_investigators. Only `reconcile`
// writes the roster, it is DRY RUN unless told otherwise, and it never deletes — dropping someone
// from the roster changes pi@ entitlement, and that stays a human decision.
//
// Deploy: supabase functions deploy reporter-pi-sync --project-ref vpexxhfpvghlejljwpvt
// Requires migration 20260826140000.
//
// Callable two ways: from the Admin Console's RePORTER PI Sync panel with an admin/curator session,
// or with the service role key -- which is what cron_invoke sends, e.g.
//   SELECT public.cron_invoke('reporter-pi-sync', '{"action":"snapshot"}'::jsonb);
import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { syncReporterPis, type ReporterPi } from "../_shared/grant-sync.ts";

// Hand-written per function, and the reason tests/guards/cors-header-parity exists: a global header
// on the browser client is sent on every functions.invoke, so a missing entry here is a silent
// preflight rejection. Keep this list identical to the other browser-callable functions.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const REPORTER = "https://api.reporter.nih.gov/v2/projects/search";
const PAGE = 100;
/** NIH asks for roughly one request per second; this stays well inside it. */
const THROTTLE_MS = 250;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

interface ReporterYear {
  core_project_num: string;
  fiscal_year: number;
  project_num: string | null;
  award_notice_date: string | null;
  pis: { profile_id: number; full_name: string; first_name: string; last_name: string; is_contact_pi: boolean; title: string }[];
}

/** Every budget year RePORTER holds for one core project number, oldest first. */
async function fetchAllYears(grantNumber: string): Promise<ReporterYear[]> {
  const years: ReporterYear[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(REPORTER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        criteria: { project_nums: [grantNumber] },
        include_fields: ["ProjectNum", "CoreProjectNum", "FiscalYear", "PrincipalInvestigators", "AwardNoticeDate"],
        offset,
        limit: PAGE,
      }),
    });
    if (!res.ok) throw new Error(`${grantNumber}: RePORTER HTTP ${res.status}`);
    const body = await res.json();
    const rows = body?.results ?? [];
    for (const r of rows) {
      years.push({
        // A core project number is what survives renewals; project_num carries the year suffix.
        core_project_num: r.core_project_num || grantNumber,
        fiscal_year: r.fiscal_year,
        project_num: r.project_num ?? null,
        award_notice_date: r.award_notice_date ? String(r.award_notice_date).slice(0, 10) : null,
        pis: (r.principal_investigators ?? [])
          .filter((p: { profile_id?: number }) => p.profile_id)
          .map((p: Record<string, unknown>) => ({
            profile_id: Number(p.profile_id),
            full_name: String(p.full_name ?? "").replace(/\s+/g, " ").trim(),
            first_name: String(p.first_name ?? "").trim(),
            last_name: String(p.last_name ?? "").trim(),
            is_contact_pi: !!p.is_contact_pi,
            title: String(p.title ?? "").trim(),
          })),
      });
    }
    offset += rows.length;
    if (rows.length < PAGE || offset >= (body?.meta?.total ?? 0)) break;
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }
  // Temporal order, oldest first — the point of the exercise.
  return years.sort((a, b) => (a.fiscal_year || 0) - (b.fiscal_year || 0));
}

/** Last names must match; first names match outright or by prefix, because RePORTER carries the
 *  legal name ("Alexander Henry Williams") where the KG carries the one people use. */
function nameMatches(a: string, b: string): boolean {
  const t = (s: string) => s.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const x = t(a), y = t(b);
  if (!x.length || !y.length) return false;
  if (x[x.length - 1] !== y[y.length - 1]) return false;
  return x[0] === y[0] || x[0].startsWith(y[0]) || y[0].startsWith(x[0]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { action = "snapshot", dry_run = true, grant_number } = await req.json().catch(() => ({}));

    // TWO CALLERS, TWO CREDENTIALS. An admin/curator JWT from the console panel, OR the service role
    // key from a scheduled run.
    //
    // The first version of this accepted only the JWT, copied from group-audit -- which is invoked
    // from a dialog with the signed-in user's session. That was the wrong precedent for a batch job:
    // `supabase functions invoke` sends the ANON key and cron_invoke sends the SERVICE ROLE key, so
    // auth.getUser() returns null for both and every automated call 401'd. nih-grants, the function
    // this one supersedes for PIs, has no gate at all for exactly that reason. A service-role bearer
    // is already trusted -- it can do anything in the database directly -- so honouring it here adds
    // no privilege, it just stops the function being unreachable by the scheduler.
    const authHeader = req.headers.get("Authorization") || "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const isServiceRole = bearer.length > 0 && bearer === serviceKey;

    if (!isServiceRole) {
      const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData } = await asUser.auth.getUser();
      const uid = userData?.user?.id;
      if (!uid) return json({ ok: false, error: "Not authenticated — sign in, or call with the service role key" }, 401);
      const { data: roles } = await asUser.from("user_roles").select("role").eq("user_id", uid);
      if (!(roles ?? []).some((r: { role: string }) => r.role === "admin" || r.role === "curator")) {
        return json({ ok: false, error: "Admin or curator only" }, 403);
      }
    }

    // Declared, not inferred: without this every write below lands at G8 'unknown' and the
    // provenance guard refuses it the moment a human has edited the same cell.
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      global: { headers: { "x-bbqs-source-class": "authoritative_registry", "x-bbqs-client": "reporter-pi-sync" } },
    });

    // ── snapshot: walk every fiscal year of every grant and record it ────────────────────────
    if (action === "snapshot") {
      let q = db.from("grants").select("grant_number").not("grant_number", "is", null);
      if (grant_number) q = q.eq("grant_number", grant_number);
      const { data: grants, error: gErr } = await q;
      if (gErr) throw new Error(gErr.message);

      const errors: string[] = [];
      let observations = 0, projectYears = 0;
      const drifted: { grant_number: string; years: { fiscal_year: number; contact: string | null; pis: string[] }[] }[] = [];

      for (const g of grants ?? []) {
        try {
          const years = await fetchAllYears(g.grant_number);
          if (!years.length) { errors.push(`${g.grant_number}: not found in RePORTER`); continue; }
          projectYears += years.length;

          const rows = years.flatMap((y) =>
            y.pis.map((p) => ({
              core_project_num: y.core_project_num,
              fiscal_year: y.fiscal_year,
              profile_id: p.profile_id,
              project_num: y.project_num,
              award_notice_date: y.award_notice_date,
              full_name: p.full_name,
              first_name: p.first_name,
              last_name: p.last_name,
              is_contact_pi: p.is_contact_pi,
              title: p.title,
              observed_at: new Date().toISOString(),
            })),
          );
          if (rows.length) {
            const { error } = await db.from("reporter_pi_observations")
              .upsert(rows, { onConflict: "core_project_num,fiscal_year,profile_id" });
            if (error) { errors.push(`${g.grant_number}: ${error.message}`); continue; }
            observations += rows.length;
          }

          // Report a project whose PI set or contact PI moved between years. This is the whole
          // reason for storing the history rather than the latest row.
          const sets = years.map((y) => y.pis.map((p) => p.profile_id).sort().join(","));
          const contacts = years.map((y) => y.pis.find((p) => p.is_contact_pi)?.profile_id ?? null);
          if (new Set(sets).size > 1 || new Set(contacts).size > 1) {
            drifted.push({
              grant_number: g.grant_number,
              years: years.map((y) => ({
                fiscal_year: y.fiscal_year,
                contact: y.pis.find((p) => p.is_contact_pi)?.full_name ?? null,
                pis: y.pis.map((p) => p.full_name),
              })),
            });
          }
        } catch (e) {
          errors.push(`${g.grant_number}: ${e instanceof Error ? e.message : "unknown"}`);
        }
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
      }

      return json({ ok: errors.length === 0, action, grants: grants?.length ?? 0, project_years: projectYears,
                    observations, changed_over_time: drifted, errors });
    }

    // ── truth: the ground-truth document, derived from the newest year on record ─────────────
    if (action === "truth") {
      const { data, error } = await db.from("reporter_pi_current").select("*").order("core_project_num");
      if (error) throw new Error(error.message);
      const byProject: Record<string, unknown> = {};
      for (const r of data ?? []) {
        const p = (byProject[r.core_project_num] ??= {
          core_project_num: r.core_project_num, fiscal_year: r.fiscal_year,
          project_num: r.project_num, award_notice_date: r.award_notice_date, principal_investigators: [],
        }) as { principal_investigators: unknown[] };
        p.principal_investigators.push({
          profile_id: r.profile_id, full_name: r.full_name,
          is_contact_pi: r.is_contact_pi, role: r.roster_role,
        });
      }
      // A file, as asked for: stable key order, one object per project, regenerated not appended.
      return json({ ok: true, action, source: "NIH RePORTER via reporter_pi_current",
                    generated_at: new Date().toISOString(),
                    projects: Object.values(byProject) });
    }

    // ── link: give investigators their RePORTER profile_id ──────────────────────────────────
    // Only where the person is ALREADY on that grant's roster and the name matches — linking inside
    // a known relationship, not searching the whole table for a name. Ambiguity is reported, never
    // guessed: a wrong profile_id merges two colleagues into one.
    if (action === "link") {
      const { data: current } = await db.from("reporter_pi_current").select("core_project_num, profile_id, full_name");
      const { data: roster } = await db.from("grant_investigators")
        .select("investigator_id, role, grants!inner(grant_number), investigators!inner(id, name, reporter_profile_id)");
      const linked: string[] = [], ambiguous: string[] = [], unmatched: string[] = [];

      for (const t of current ?? []) {
        const onThisGrant = (roster ?? []).filter((r: any) => r.grants?.grant_number === t.core_project_num);
        const hits = onThisGrant.filter((r: any) => nameMatches(r.investigators.name, t.full_name));
        if (hits.length === 0) { unmatched.push(`${t.core_project_num}: ${t.full_name} (profile ${t.profile_id})`); continue; }
        if (hits.length > 1) { ambiguous.push(`${t.core_project_num}: ${t.full_name} matches ${hits.length} records`); continue; }
        const inv = (hits[0] as any).investigators;
        if (inv.reporter_profile_id) continue;                      // already anchored
        if (!dry_run) {
          const { error } = await db.from("investigators")
            .update({ reporter_profile_id: t.profile_id }).eq("id", inv.id);
          if (error) { ambiguous.push(`${inv.name}: ${error.message}`); continue; }
        }
        linked.push(`${inv.name} -> ${t.profile_id}`);
      }
      return json({ ok: true, action, dry_run, linked: linked.length, linked_detail: linked, ambiguous, unmatched });
    }

    // ── drift: where the KG roster and RePORTER disagree. Reads only. ────────────────────────
    if (action === "drift") {
      const { data, error } = await db.from("reporter_pi_drift").select("*").neq("drift", "agrees");
      if (error) throw new Error(error.message);
      return json({ ok: true, action, rows: data?.length ?? 0, drift: data });
    }

    // ── reconcile: apply the current PIs to grant_investigators ──────────────────────────────
    // Additive. syncReporterPis inserts what is missing, refreshes rows it wrote before, and leaves
    // curator rows alone. Nothing is ever deleted: a person disappearing from a RePORTER record is
    // reported here and decided by a human, because it revokes pi@ entitlement.
    if (action === "reconcile") {
      const { data: current } = await db.from("reporter_pi_current").select("*");
      if (!current?.length) return json({ ok: false, error: "no observations yet — run action 'snapshot' first" }, 409);

      const { data: grants } = await db.from("grants").select("id, grant_number");
      const grantId = new Map((grants ?? []).map((g: { id: string; grant_number: string }) => [g.grant_number, g.id]));
      const { data: people } = await db.from("investigators").select("id, name, reporter_profile_id");
      const byProfile = new Map((people ?? []).filter((p: any) => p.reporter_profile_id)
        .map((p: any) => [Number(p.reporter_profile_id), p.id]));

      const byProject = new Map<string, ReporterPi[]>();
      const unlinked: string[] = [];
      for (const t of current) {
        const id = byProfile.get(Number(t.profile_id));
        if (!id) { unlinked.push(`${t.core_project_num}: ${t.full_name} (profile ${t.profile_id}) has no investigators row anchored to it`); continue; }
        const list = byProject.get(t.core_project_num) ?? [];
        list.push({ investigatorId: id, name: t.full_name, isContactPi: !!t.is_contact_pi });
        byProject.set(t.core_project_num, list);
      }

      const applied: Record<string, unknown> = {};
      for (const [gn, pis] of byProject) {
        const gid = grantId.get(gn);
        if (!gid) continue;
        applied[gn] = dry_run ? { would_sync: pis.map((p) => `${p.name}${p.isContactPi ? " [contact]" : ""}`) }
                              : await syncReporterPis(db, gid, gn, pis);
      }
      // Roster rows RePORTER does not confirm. Reported, never removed.
      const { data: extra } = await db.from("reporter_pi_drift").select("*").eq("drift", "not_in_reporter");
      return json({ ok: true, action, dry_run, projects: Object.keys(applied).length, applied,
                    unlinked_reporter_pis: unlinked,
                    on_our_roster_but_not_in_reporter: extra,
                    note: dry_run ? "dry run — nothing was written. Send {\"dry_run\": false} to apply." : undefined });
    }

    return json({ ok: false, error: `unknown action '${action}' — use snapshot | truth | link | drift | reconcile` }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
