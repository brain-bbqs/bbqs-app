import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { getCorsHeaders, requireAuth } from "../_shared/auth.ts";
import { findOrCreateOrganization, isUniqueViolation, kgSession } from "../_shared/kg-write.ts";

interface Mismatch {
  investigator_id: string;
  name: string;
  current_orgs: string[];
  nih_org: string;
  grant_number: string;
  status: "mismatch" | "missing" | "verified";
}

/**
 * Query NIH RePORTER for a PI's most recent grant to get their current institution.
 */
async function fetchNihAffiliation(
  piName: string,
  grantNumbers: string[]
): Promise<{ org: string; grantNumber: string } | null> {
  // Try each grant number, prefer the most recent
  for (const gn of grantNumbers) {
    try {
      const response = await fetch("https://api.reporter.nih.gov/v2/projects/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          criteria: { project_nums: [gn] },
          include_fields: ["ProjectNum", "Organization", "FiscalYear", "PrincipalInvestigators"],
          offset: 0,
          limit: 1,
        }),
      });

      if (!response.ok) {
        await response.text();
        continue;
      }

      const data = await response.json();
      const project = data.results?.[0];
      if (project?.organization?.org_name) {
        return {
          org: project.organization.org_name,
          grantNumber: project.project_num || gn,
        };
      }
    } catch (err) {
      console.error(`NIH lookup failed for ${gn}:`, err);
    }
    // Rate limit
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/**
 * Query ORCID public API for current employment.
 */
async function fetchOrcidAffiliation(orcid: string): Promise<string | null> {
  try {
    const response = await fetch(`https://pub.orcid.org/v3.0/${orcid}/employments`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      await response.text();
      return null;
    }
    const data = await response.json();
    const groups = data["affiliation-group"] || [];
    // Find the most recent employment (no end-date = current)
    for (const group of groups) {
      const summaries = group["summaries"] || [];
      for (const s of summaries) {
        const emp = s["employment-summary"];
        if (emp && !emp["end-date"]) {
          return emp["organization"]?.["name"] || null;
        }
      }
    }
    // Fallback: first employment
    if (groups.length > 0) {
      const first = groups[0]?.["summaries"]?.[0]?.["employment-summary"];
      return first?.["organization"]?.["name"] || null;
    }
  } catch (err) {
    console.error(`ORCID lookup failed for ${orcid}:`, err);
  }
  return null;
}

function normalizeOrgName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\b(the|of|at|and|in)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function orgsMatch(a: string, b: string): boolean {
  const na = normalizeOrgName(a);
  const nb = normalizeOrgName(b);
  // Exact match after normalization
  if (na === nb) return true;
  // One contains the other
  if (na.includes(nb) || nb.includes(na)) return true;
  // Check key words overlap (at least 2 significant words in common)
  const wordsA = new Set(na.split(" ").filter((w) => w.length > 3));
  const wordsB = new Set(nb.split(" ").filter((w) => w.length > 3));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap >= 2;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Require authentication
  const auth = await requireAuth(req, corsHeaders);
  if (auth.error) return auth.error;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // ?action=fix writes with the service role, so the writes name themselves and the caller
  // (Principle X); without the header they read 'unknown' in data_audit_log. Server-side client only.
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    global: { headers: { "x-bbqs-client": `verify-affiliations:${auth.user?.email ?? auth.user?.id ?? "unknown-user"}` } },
  });

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "check";
    const investigatorId = url.searchParams.get("id"); // optional: verify single PI

    // Fetch investigators with their org links and grant links
    let invQuery = supabase.from("investigators").select("id, name, orcid, email");
    if (investigatorId) {
      invQuery = invQuery.eq("id", investigatorId);
    }
    const { data: investigators, error: invErr } = await invQuery;
    if (invErr) throw new Error(invErr.message);

    const invIds = investigators!.map((i) => i.id);

    // Fetch org links
    const { data: orgLinks } = await supabase
      .from("investigator_organizations")
      .select("investigator_id, organization_id")
      .in("investigator_id", invIds);

    // Fetch orgs
    const orgIds = [...new Set((orgLinks || []).map((ol) => ol.organization_id))];
    const { data: orgs } = orgIds.length
      ? await supabase.from("organizations").select("id, name").in("id", orgIds)
      : { data: [] };
    const orgById = new Map((orgs || []).map((o) => [o.id, o.name]));

    // Fetch grant links
    const { data: grantLinks } = await supabase
      .from("grant_investigators")
      .select("investigator_id, grant_id")
      .in("investigator_id", invIds);

    // Resolve grant_ids to grant_numbers for display
    const allGrantIds = [...new Set((grantLinks || []).map(gl => gl.grant_id).filter(Boolean))];
    const { data: grantsForLinks } = allGrantIds.length
      ? await supabase.from("grants").select("id, grant_number").in("id", allGrantIds)
      : { data: [] };
    const grantNumById = new Map((grantsForLinks || []).map(g => [g.id, g.grant_number]));

    // Group data by investigator
    const invOrgMap = new Map<string, string[]>();
    for (const ol of orgLinks || []) {
      const names = invOrgMap.get(ol.investigator_id) || [];
      const orgName = orgById.get(ol.organization_id);
      if (orgName) names.push(orgName);
      invOrgMap.set(ol.investigator_id, names);
    }

    const invGrantMap = new Map<string, string[]>();
    for (const gl of grantLinks || []) {
      const nums = invGrantMap.get(gl.investigator_id) || [];
      const gn = grantNumById.get(gl.grant_id);
      if (gn) nums.push(gn);
      invGrantMap.set(gl.investigator_id, nums);
    }

    const results: Mismatch[] = [];
    let processed = 0;

    for (const inv of investigators!) {
      const currentOrgs = invOrgMap.get(inv.id) || [];
      const grants = invGrantMap.get(inv.id) || [];

      // Try NIH RePORTER first
      let nihResult: { org: string; grantNumber: string } | null = null;
      if (grants.length > 0) {
        nihResult = await fetchNihAffiliation(inv.name, grants);
      }

      // Fallback to ORCID
      let orcidOrg: string | null = null;
      if (!nihResult && inv.orcid) {
        orcidOrg = await fetchOrcidAffiliation(inv.orcid);
      }

      const externalOrg = nihResult?.org || orcidOrg;
      
      if (!externalOrg) {
        // Can't verify - no external data
        results.push({
          investigator_id: inv.id,
          name: inv.name,
          current_orgs: currentOrgs,
          nih_org: "",
          grant_number: grants[0] || "",
          status: "missing",
        });
        continue;
      }

      // Check if any current org matches
      const matched = currentOrgs.some((co) => orgsMatch(co, externalOrg));

      if (matched) {
        results.push({
          investigator_id: inv.id,
          name: inv.name,
          current_orgs: currentOrgs,
          nih_org: externalOrg,
          grant_number: nihResult?.grantNumber || "",
          status: "verified",
        });
      } else {
        results.push({
          investigator_id: inv.id,
          name: inv.name,
          current_orgs: currentOrgs,
          nih_org: externalOrg,
          grant_number: nihResult?.grantNumber || "",
          status: "mismatch",
        });
      }

      processed++;
      // Rate limit: be polite to NIH API
      if (processed % 5 === 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // If action is "fix", auto-update mismatched affiliations
    if (action === "fix") {
      const kg = kgSession(supabase);
      for (const r of results.filter((r) => r.status === "mismatch" && r.nih_org)) {
        // The organization first, found by name key ("UNIVERSITY OF X" is the curated "University of
        // X"), created only if it is not in the KG; nothing is relinked if it cannot be written.
        const org = await findOrCreateOrganization(kg, r.nih_org);
        if (!org.ok) {
          console.error(`Failed to find or create org ${r.nih_org}:`, org.error);
          continue;
        }
        const orgId = org.row.id;

        // Link the new organization, then remove the old links, so a failed insert never leaves the
        // person with none.
        const { error: linkErr } = await supabase
          .from("investigator_organizations")
          .insert({ investigator_id: r.investigator_id, organization_id: orgId });
        if (linkErr && !isUniqueViolation(linkErr)) {
          console.error(`Failed to link ${r.name} to ${r.nih_org}:`, linkErr);
          continue;
        }
        await supabase
          .from("investigator_organizations")
          .delete()
          .eq("investigator_id", r.investigator_id)
          .neq("organization_id", orgId);

        r.status = "verified" as any;
      }
    }

    const summary = {
      total: results.length,
      verified: results.filter((r) => r.status === "verified").length,
      mismatches: results.filter((r) => r.status === "mismatch").length,
      missing: results.filter((r) => r.status === "missing").length,
    };

    return new Response(
      JSON.stringify({ success: true, summary, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in verify-affiliations:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
