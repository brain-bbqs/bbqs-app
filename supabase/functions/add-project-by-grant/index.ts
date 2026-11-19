// Admin/curator-only: look up a grant by NIH RePORTER number, register it
// locally if not already present, and report what RePORTER already knows.
//
// Response shape:
//   { status: "exists_locally" | "created_from_reporter" | "not_found",
//     grant_number: string,
//     grant?: { title, abstract, fiscal_year, award_amount, contact_pi, institution, nih_link },
//     populated_fields: string[],   // RePORTER-provided fields the user does NOT need to fill
//     missing_fields: string[]      // questionnaire fields still empty / TBD
//   }

import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { syncReporterPis, type ReporterPi } from "../_shared/grant-sync.ts";
import { awardKey, nihAwardCore } from "../_shared/identity-keys.ts";
import { findOrCreateInvestigator, findOrCreateOrganization, isUniqueViolation, kgSession, uniqueViolationText } from "../_shared/kg-write.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Always return 200 so the Supabase JS SDK delivers the body to the client.
// Errors are signalled via { ok: false, error, ... } in the JSON payload.
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function ok(body: Record<string, unknown>) {
  return jsonResponse({ ok: true, ...body }, 200);
}
function fail(error: string, extra: Record<string, unknown> = {}) {
  return jsonResponse({ ok: false, error, ...extra }, 200);
}

// NIH RePORTER grant numbers look like: optional 1-digit prefix, 1 letter activity-code section letter
// (R, U, K, F, T, P, etc.), 2 chars activity code, 2-letter institute (DA, MH, etc.), 6 digits, optional -dd suffix.
// Be permissive but reject anything not alphanumeric (+ optional hyphen).
const GRANT_RE = /^[A-Za-z0-9]{6,20}(-\d{1,3})?$/;

/** Reduce any NIH award number to its STABLE CORE: activity code + institute + serial.
 *
 *  RePORTER's project_num is not stable — the leading digit is the application TYPE and the suffix
 *  is the SUPPORT YEAR, so the same award reports as 1R34DA059506-01 in FY2024 and 5R34DA059506-02
 *  in FY2025. Storing what the admin typed is how 6 of 31 grants ended up prefixed (1R61MH138967)
 *  and one suffixed (1U01MH144347-01) while the other 25 were bare — see migration 20260810170000.
 *
 *  The core is also a valid RePORTER search key (verified against all 31 grants), so normalizing
 *  BEFORE the lookup is safe as well as more consistent. Input that does not match the NIH shape is
 *  passed through cleaned but otherwise untouched, rather than mangled.
 *
 *  The core is nihAwardCore's (_shared/identity-keys.ts, the rule uq_grants_award_key compares by).
 *  This function's own [A-Z]\d{2} once missed activity codes whose second character is a letter:
 *  RF1, UG3, DP2. */
function normalizeGrantNumber(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, "");
  return nihAwardCore(cleaned) ?? cleaned;
}

async function fetchGrantFromReporter(grantNumber: string) {
  try {
    const res = await fetch("https://api.reporter.nih.gov/v2/projects/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        criteria: { project_nums: [grantNumber] },
        include_fields: [
          "ProjectNum", "ProjectTitle", "ContactPiName", "PrincipalInvestigators",
          "Organization", "FiscalYear", "AwardAmount", "AbstractText", "CoreProjectNum",
        ],
        offset: 0,
        limit: 1,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const project = data?.results?.[0];
    if (!project) return null;

    const pis = project.principal_investigators || [];
    const piDetails = pis.map((pi: any) => ({
      fullName: pi.full_name || "",
      firstName: pi.first_name || "",
      lastName: pi.last_name || "",
      profileId: pi.profile_id || null,
      isContactPi: pi.is_contact_pi || false,
    }));

    return {
      grantNumber: project.project_num || grantNumber,
      title: project.project_title || "Unknown",
      abstract: project.abstract_text || "",
      contactPi: project.contact_pi_name || "Unknown",
      piDetails,
      institution: project.organization?.org_name || "Unknown",
      fiscalYear: project.fiscal_year || 0,
      awardAmount: project.award_amount || 0,
      nihLink: `https://reporter.nih.gov/project-details/${encodeURIComponent(project.project_num || grantNumber)}`,
    };
  } catch (err) {
    console.error(`RePORTER fetch failed for ${grantNumber}:`, err);
    return null;
  }
}

// Mirror of the 7 questionnaire dimensions used by the project completeness score.
const QUESTIONNAIRE_FIELDS = [
  "study_species",
  "keywords",
  "website",
  "data_types",
  "sensors",
  "analysis_methods",
  "analysis_types",
];

function summarizePopulation(project: any): { populated: string[]; missing: string[] } {
  const populated: string[] = [];
  const missing: string[] = [];
  if (!project) {
    return { populated: [], missing: QUESTIONNAIRE_FIELDS };
  }
  const md = project.metadata || {};
  for (const f of QUESTIONNAIRE_FIELDS) {
    if (f === "study_species" || f === "keywords") {
      const arr = (project as any)[f];
      if (Array.isArray(arr) && arr.length > 0) populated.push(f);
      else missing.push(f);
    } else if (f === "website") {
      if ((project as any).website) populated.push(f);
      else missing.push(f);
    } else {
      const v = md[f];
      if (Array.isArray(v) ? v.length > 0 : !!v) populated.push(f);
      else missing.push(f);
    }
  }
  return { populated, missing };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return fail("Method not allowed");
  }

  // ── Auth: require admin or curator ─────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    console.error("[add-project-by-grant] missing/invalid Authorization header");
    return fail("You're not signed in. Please sign in with an admin or curator account and try again.");
  }
  const token = authHeader.slice(7).trim();

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  // Service-role client for token validation and the role check.
  const authClient = createClient(supabaseUrl, serviceKey);

  // Validate the JWT explicitly using the service-role client.
  const { data: userRes, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userRes?.user) {
    console.error("[add-project-by-grant] getUser failed:", userErr?.message, "token len:", token.length);
    return fail(`Your sign-in session is invalid or expired. Please sign in again. (${userErr?.message ?? "no user"})`);
  }
  console.log("[add-project-by-grant] authenticated user:", userRes.user.email, userRes.user.id);

  const { data: roles } = await authClient
    .from("user_roles")
    .select("role")
    .eq("user_id", userRes.user.id);
  const roleSet = new Set((roles ?? []).map((r) => r.role));
  if (!roleSet.has("admin") && !roleSet.has("curator")) {
    return fail(
      `Only admins or curators can register new projects, and ${userRes.user.email ?? "your account"} doesn't have that role. Please ask a consortium admin to import this grant.`,
    );
  }

  // The writes: service role, so they name themselves and the curator who asked (Principle X).
  // Without x-bbqs-client they read 'unknown' in data_audit_log. Set on this server-side client only.
  const admin = createClient(supabaseUrl, serviceKey, {
    global: { headers: { "x-bbqs-client": `add-project-by-grant:${userRes.user.email ?? userRes.user.id}` } },
  });
  const kg = kgSession(admin);

  // ── Parse + validate body ──────────────────────────────────
  let body: any;
  try { body = await req.json(); } catch { return fail("Invalid JSON"); }
  const raw = typeof body?.grant_number === "string" ? body.grant_number : "";
  if (!raw) return fail("grant_number is required");
  const grantNumber = normalizeGrantNumber(raw);
  if (!GRANT_RE.test(grantNumber)) {
    return fail("Invalid grant number format. Example: R34DA059510");
  }

  // ── 1. Already in our DB? By award key: '1R61MH138612' and 'R61MH138612' are one award ──
  const { data: projects, error: projErr } = await admin
    .from("projects")
    .select("grant_number, study_species, keywords, website, metadata, grants:grant_id(title,abstract,fiscal_year,award_amount,nih_link)");
  if (projErr) return fail("Could not read the projects to check for this grant", { details: projErr.message });
  const existingProject = (projects ?? []).find((p: { grant_number: string }) => awardKey(p.grant_number) === awardKey(grantNumber));

  if (existingProject) {
    const { populated, missing } = summarizePopulation(existingProject);
    return ok({
      status: "exists_locally",
      grant_number: grantNumber,
      grant: existingProject.grants ?? null,
      populated_fields: populated,
      missing_fields: missing,
    });
  }

  // ── 2. Look up on RePORTER ─────────────────────────────────
  const reporter = await fetchGrantFromReporter(grantNumber);
  if (!reporter) {
    // Hard stop: do NOT seed anything when RePORTER has no record.
    return ok({
      status: "not_found",
      grant_number: grantNumber,
      message:
        `Grant ${grantNumber} was not found on NIH RePORTER, so it was not added. ` +
        `Double-check the format (e.g. R34DA059510) or confirm the grant exists at reporter.nih.gov.`,
    });
  }

  // ── 3. Seed grant + project rows (light version of nih-grants seeder) ──
  // A grant row may already hold this award without a project (create_grant, or another spelling of
  // its number): it is updated by id, never shadowed by a second row.
  const fields = {
    // The full per-year RePORTER string, kept so shortening grant_number loses nothing. Refreshed
    // on every sync because it changes each fiscal year (migration 20260810170000).
    reporter_project_num: reporter.grantNumber ?? null,
    title: reporter.title,
    abstract: reporter.abstract || null,
    award_amount: reporter.awardAmount || null,
    fiscal_year: reporter.fiscalYear || null,
    nih_link: reporter.nihLink,
    updated_at: new Date().toISOString(),
  };
  const { data: grants, error: grantsErr } = await admin.from("grants").select("id, grant_number");
  if (grantsErr) return fail("Could not read the grants to check for this award", { details: grantsErr.message });
  const known = (grants ?? []).find((g: { grant_number: string }) => awardKey(g.grant_number) === awardKey(grantNumber));
  const { data: grantRow, error: grantErr } = await (known
    ? admin.from("grants").update(fields).eq("id", known.id)
    : admin.from("grants").insert({ grant_number: grantNumber, ...fields }))
    .select("id, grant_number, resource_id")
    .single();

  if (grantErr || !grantRow) {
    console.error("Failed to write grant:", grantErr);
    // A 23505 is another writer's row for this award (uq_grants_award_key), written after the read.
    if (isUniqueViolation(grantErr)) {
      return fail(`Grant ${grantNumber} is already in the KG (written in the meantime); add it again to see that record`, { details: uniqueViolationText(grantErr) });
    }
    return fail("Failed to register grant locally", { details: grantErr?.message });
  }
  const storedNumber: string = grantRow.grant_number;

  // Resource hub node for the grant
  if (!grantRow.resource_id) {
    const { data: resourceRow } = await admin
      .from("resources")
      .insert({
        name: reporter.title,
        resource_type: "grant",
        description: (reporter.abstract || "").slice(0, 500) || null,
      })
      .select("id")
      .single();
    if (resourceRow) {
      await admin.from("grants").update({ resource_id: resourceRow.id }).eq("id", grantRow.id);
    }
  }

  // Organization (found by name key, created only if missing) and investigators (found by RePORTER
  // profile id, name key, or a unique first + last name; a new person before their spine row), the
  // same helpers the bulk nih-grants refresh uses. Then defer the grant_investigators link creation
  // to the shared syncReporterPis helper so behaviour matches that refresh exactly.
  const warnings: string[] = [];
  let orgId: string | null = null;
  if (reporter.institution && reporter.institution !== "Unknown") {
    const org = await findOrCreateOrganization(kg, reporter.institution);
    if (org.ok) orgId = org.row.id;
    else warnings.push(`organization not linked: ${org.error}`);
  }

  const reporterPis: ReporterPi[] = [];
  for (const pi of reporter.piDetails) {
    const piName = (pi.fullName || "").trim();
    if (!piName) continue;
    const person = await findOrCreateInvestigator(kg, { name: piName, reporterProfileId: pi.profileId });
    if (!person.ok) {
      warnings.push(`${piName} not linked: ${person.error}`);
      continue;
    }
    const invId = person.row.id;

    if (orgId) {
      const { data: existingLink } = await admin
        .from("investigator_organizations")
        .select("investigator_id")
        .eq("investigator_id", invId).eq("organization_id", orgId)
        .maybeSingle();
      if (!existingLink) {
        await admin.from("investigator_organizations").insert({ investigator_id: invId, organization_id: orgId });
      }
    }

    reporterPis.push({
      investigatorId: invId,
      name: piName,
      isContactPi: !!pi.isContactPi,
    });
  }
  await syncReporterPis(admin, grantRow.id, storedNumber, reporterPis);

  // Project row (step 1 found none for this award)
  const { error: projectErr } = await admin.from("projects").insert({
    grant_number: storedNumber,
    grant_id: grantRow.id,
    last_edited_by: userRes.user.email || "reporter-import",
  });
  if (projectErr) {
    warnings.push(isUniqueViolation(projectErr)
      ? `project row not added: one is already in the KG for this award (${uniqueViolationText(projectErr)}), written in the meantime`
      : `project row not written: ${projectErr.message}`);
  }

  // Newly created → no questionnaire fields populated yet
  return ok({
    status: "created_from_reporter",
    grant_number: grantNumber,
    grant: {
      title: reporter.title,
      abstract: reporter.abstract,
      fiscal_year: reporter.fiscalYear,
      award_amount: reporter.awardAmount,
      contact_pi: reporter.contactPi,
      institution: reporter.institution,
      nih_link: reporter.nihLink,
    },
    populated_fields: [],          // none of the questionnaire fields
    missing_fields: QUESTIONNAIRE_FIELDS,
    reporter_seeded: ["title", "abstract", "fiscal_year", "award_amount", "principal_investigators", "institution"],
    // What could not be matched or written (a PI two records fit, an organization refused): for a curator.
    ...(warnings.length ? { warnings } : {}),
  });
});
