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
 *  passed through cleaned but otherwise untouched, rather than mangled. */
function normalizeGrantNumber(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, "");
  const m = cleaned.match(/^\d*([A-Z]\d{2}[A-Z]{2}\d{6})(?:-\d+[A-Z0-9]*)?$/);
  return m ? m[1] : cleaned;
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

  // Service-role client for token validation, role check, and writes.
  const admin = createClient(supabaseUrl, serviceKey);

  // Validate the JWT explicitly using the service-role client.
  const { data: userRes, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userRes?.user) {
    console.error("[add-project-by-grant] getUser failed:", userErr?.message, "token len:", token.length);
    return fail(`Your sign-in session is invalid or expired. Please sign in again. (${userErr?.message ?? "no user"})`);
  }
  console.log("[add-project-by-grant] authenticated user:", userRes.user.email, userRes.user.id);

  const { data: roles } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userRes.user.id);
  const roleSet = new Set((roles ?? []).map((r) => r.role));
  if (!roleSet.has("admin") && !roleSet.has("curator")) {
    return fail(
      `Only admins or curators can register new projects, and ${userRes.user.email ?? "your account"} doesn't have that role. Please ask a consortium admin to import this grant.`,
    );
  }

  // ── Parse + validate body ──────────────────────────────────
  let body: any;
  try { body = await req.json(); } catch { return fail("Invalid JSON"); }
  const raw = typeof body?.grant_number === "string" ? body.grant_number : "";
  if (!raw) return fail("grant_number is required");
  const grantNumber = normalizeGrantNumber(raw);
  if (!GRANT_RE.test(grantNumber)) {
    return fail("Invalid grant number format. Example: R34DA059510");
  }

  // ── 1. Already in our DB? ──────────────────────────────────
  const { data: existingProject } = await admin
    .from("projects")
    .select("grant_number, study_species, keywords, website, metadata, grants:grant_id(title,abstract,fiscal_year,award_amount,nih_link)")
    .eq("grant_number", grantNumber)
    .maybeSingle();

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
  const { data: grantRow, error: grantErr } = await admin
    .from("grants")
    .upsert({
      grant_number: grantNumber,
      // The full per-year RePORTER string, kept so shortening grant_number loses nothing. Refreshed
      // on every sync because it changes each fiscal year (migration 20260810170000).
      reporter_project_num: reporter.grantNumber ?? null,
      title: reporter.title,
      abstract: reporter.abstract || null,
      award_amount: reporter.awardAmount || null,
      fiscal_year: reporter.fiscalYear || null,
      nih_link: reporter.nihLink,
      updated_at: new Date().toISOString(),
    }, { onConflict: "grant_number" })
    .select("id, resource_id")
    .single();

  if (grantErr || !grantRow) {
    console.error("Failed to upsert grant:", grantErr);
    return fail("Failed to register grant locally", { details: grantErr?.message });
  }

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

  // Organization (lookup or create)
  let orgId: string | null = null;
  if (reporter.institution && reporter.institution !== "Unknown") {
    const { data: existingOrg } = await admin
      .from("organizations").select("id").ilike("name", reporter.institution).maybeSingle();
    if (existingOrg) orgId = existingOrg.id;
    else {
      const { data: newOrg } = await admin
        .from("organizations").insert({ name: reporter.institution }).select("id").single();
      orgId = newOrg?.id || null;
    }
  }

  // Investigators (ensure they exist + are linked to org). Then defer the
  // grant_investigators link creation to the shared syncReporterPis helper
  // so behaviour matches the bulk nih-grants refresh exactly.
  const reporterPis: ReporterPi[] = [];
  for (const pi of reporter.piDetails) {
    const piName = (pi.fullName || "").trim();
    if (!piName) continue;
    const { data: existingInv } = await admin
      .from("investigators").select("id").ilike("name", piName).maybeSingle();

    let invId: string;
    if (existingInv) invId = existingInv.id;
    else {
      const { data: invRes } = await admin
        .from("resources").insert({ name: piName, resource_type: "investigator" }).select("id").single();
      const { data: newInv } = await admin
        .from("investigators").insert({ name: piName, resource_id: invRes?.id || null })
        .select("id").single();
      if (!newInv) continue;
      invId = newInv.id;
    }

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
  await syncReporterPis(admin, grantRow.id, grantNumber, reporterPis);

  // Project row
  await admin.from("projects").insert({
    grant_number: grantNumber,
    grant_id: grantRow.id,
    last_edited_by: userRes.user.email || "reporter-import",
  });

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
  });
});
