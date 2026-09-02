import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { syncReporterPis, type ReporterPi } from "../_shared/grant-sync.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// BOOTSTRAP ONLY — the list to seed an empty database from. Every other path reads grant numbers
// from the grants table via loadGrantNumbers(), because this array goes stale the moment an award
// is added: it held 29 while grants held 31, so refresh and the weekly reconcile cron silently
// skipped 2 awards, and would have skipped R61MH142354 forever.
const GRANT_NUMBERS = [
  "R34DA059510", "R34DA059509", "R34DA059513", "R34DA059507",
  "R34DA059718", "R34DA059506", "R34DA059512", "R34DA059716",
  "R34DA059723", "R34DA059514", "R34DA059500", "R34DA061984",
  "R34DA061924", "R34DA061925", "R34DA062119", "R61MH135106",
  "R61MH135109", "R61MH135114", "R61MH135405", "R61MH135407",
  "R61MH138966", "R61MH138713", "R61MH138705", "1U01DA063534",
  "U24MH136628", "R24MH136632",
  "1U01DA063565", "1U01DA063581", "1R61MH138612"
];

/** Grant numbers to sync: the live roster, falling back to the bootstrap list when empty. */
async function loadGrantNumbers(supabase: any): Promise<string[]> {
  const { data, error } = await supabase
    .from("grants")
    .select("grant_number")
    .order("grant_number");
  if (error) {
    console.error("[nih-grants] grants read failed, using bootstrap list:", error.message);
    return GRANT_NUMBERS;
  }
  const live = (data || []).map((g: any) => g.grant_number).filter(Boolean);
  return live.length > 0 ? live : GRANT_NUMBERS;
}

// ─── PubMed / iCite helpers ─────────────────────────────────

async function fetchPubMedKeywords(pmids: string[]): Promise<Map<string, string[]>> {
  const keywordsMap = new Map<string, string[]>();
  if (pmids.length === 0) return keywordsMap;

  try {
    const batchSize = 50;
    for (let i = 0; i < pmids.length; i += batchSize) {
      const batch = pmids.slice(i, i + batchSize);
      const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${batch.join(",")}&rettype=xml&retmode=xml`;
      const response = await fetch(url);
      if (!response.ok) continue;

      const xml = await response.text();
      const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
      let match;
      while ((match = articleRegex.exec(xml)) !== null) {
        const article = match[1];
        const pmidMatch = article.match(/<PMID[^>]*>(\d+)<\/PMID>/);
        if (!pmidMatch) continue;
        const pmid = pmidMatch[1];
        const keywords: string[] = [];

        const meshRegex = /<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/g;
        let meshMatch;
        while ((meshMatch = meshRegex.exec(article)) !== null) {
          keywords.push(meshMatch[1]);
        }

        const kwRegex = /<Keyword[^>]*>([^<]+)<\/Keyword>/g;
        let kwMatch;
        while ((kwMatch = kwRegex.exec(article)) !== null) {
          if (!keywords.includes(kwMatch[1])) keywords.push(kwMatch[1]);
        }

        keywordsMap.set(pmid, keywords);
      }

      if (i + batchSize < pmids.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  } catch (err) {
    console.error("Error fetching PubMed keywords:", err);
  }

  return keywordsMap;
}

async function fetchPubMedDetails(pmids: string[]): Promise<Map<string, any>> {
  const detailsMap = new Map<string, any>();
  if (pmids.length === 0) return detailsMap;

  try {
    const response = await fetch(`https://icite.od.nih.gov/api/pubs?pmids=${pmids.join(",")}`);
    if (!response.ok) return detailsMap;

    const data = await response.json();
    const pubs = data.data || data;

    for (const pub of pubs) {
      detailsMap.set(String(pub.pmid), {
        title: pub.title || "Unknown",
        year: pub.year || 0,
        journal: pub.journal || "Unknown",
        authors: pub.authors || "",
        citations: pub.citation_count || 0,
        rcr: pub.relative_citation_ratio || 0,
        doi: pub.doi || ""
      });
    }
  } catch (err) {
    console.error("Error fetching iCite details:", err);
  }

  return detailsMap;
}

async function fetchPublications(coreProjectNum: string): Promise<any[]> {
  try {
    const response = await fetch("https://api.reporter.nih.gov/v2/publications/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        criteria: { core_project_nums: [coreProjectNum] },
        offset: 0,
        limit: 100
      })
    });

    if (!response.ok) return [];

    const data = await response.json();
    const nihPubs = data.results || [];
    if (nihPubs.length === 0) return [];

    const pmids = nihPubs.map((p: any) => String(p.pmid)).filter(Boolean);

    const [detailsMap, keywordsMap] = await Promise.all([
      fetchPubMedDetails(pmids),
      fetchPubMedKeywords(pmids),
    ]);

    return nihPubs.map((pub: any) => {
      const pmid = String(pub.pmid);
      const details = detailsMap.get(pmid) || {};
      const keywords = keywordsMap.get(pmid) || [];
      return {
        pmid,
        title: details.title || "Unknown",
        year: details.year || 0,
        journal: details.journal || "Unknown",
        authors: details.authors || "",
        citations: details.citations || 0,
        rcr: details.rcr || 0,
        keywords,
        pubmedLink: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : ""
      };
    });
  } catch (err) {
    console.error(`Error fetching publications for ${coreProjectNum}:`, err);
    return [];
  }
}

// ─── NIH Reporter fetch ────────────────────────────────────

async function fetchGrantData(grantNumber: string): Promise<any | null> {
  try {
    const response = await fetch("https://api.reporter.nih.gov/v2/projects/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        criteria: { project_nums: [grantNumber] },
        include_fields: [
          "ProjectNum", "ProjectTitle", "ContactPiName", "PrincipalInvestigators",
          "Organization", "FiscalYear", "AwardAmount", "AbstractText", "CoreProjectNum"
        ],
        offset: 0,
        limit: 1
      })
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (!data.results || data.results.length === 0) return null;

    const project = data.results[0];
    const pis = project.principal_investigators || [];
    const coreProjectNum = project.core_project_num || grantNumber.replace(/-\d+$/, "");
    const publications = await fetchPublications(coreProjectNum);

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
      allPis: pis.map((pi: any) => pi.full_name).join(", ") || project.contact_pi_name || "Unknown",
      piDetails,
      institution: project.organization?.org_name || "Unknown",
      fiscalYear: project.fiscal_year || 0,
      awardAmount: project.award_amount || 0,
      nihLink: `https://reporter.nih.gov/project-details/${encodeURIComponent(project.project_num || grantNumber)}`,
      publications,
      publicationCount: publications.length
    };
  } catch (err) {
    console.error(`Error fetching ${grantNumber}:`, err);
    return null;
  }
}

// ─── Full entity seeding pipeline ───────────────────────────
// Given a grant number and its fetched data, ensures all related
// entities exist: organization, resource nodes, investigators,
// grant_investigators links, and project metadata row.

async function seedGrantEntities(supabase: any, grantNumber: string, projectData: any) {
  // 1. Upsert grant row
  const { data: grantRow } = await supabase
    .from("grants")
    .upsert({
      grant_number: grantNumber,
      title: projectData.title || "Unknown",
      abstract: projectData.abstract || null,
      award_amount: projectData.awardAmount || null,
      fiscal_year: projectData.fiscalYear || null,
      nih_link: projectData.nihLink || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "grant_number" })
    .select("id, resource_id")
    .single();

  if (!grantRow) {
    console.error(`Failed to upsert grant ${grantNumber}`);
    return;
  }

  const grantId = grantRow.id;

  // 2. Ensure grant has a resource node
  if (!grantRow.resource_id) {
    const { data: grantResource } = await supabase
      .from("resources")
      .insert({
        name: projectData.title || grantNumber,
        resource_type: "grant",
        description: (projectData.abstract || "").slice(0, 500) || null,
      })
      .select("id")
      .single();

    if (grantResource) {
      await supabase
        .from("grants")
        .update({ resource_id: grantResource.id })
        .eq("id", grantId);
    }
  }

  // 3. Ensure organization exists
  const institutionName = projectData.institution;
  let orgId: string | null = null;
  if (institutionName && institutionName !== "Unknown") {
    const { data: existingOrg } = await supabase
      .from("organizations")
      .select("id")
      .ilike("name", institutionName)
      .maybeSingle();

    if (existingOrg) {
      orgId = existingOrg.id;
    } else {
      const { data: newOrg } = await supabase
        .from("organizations")
        .insert({ name: institutionName })
        .select("id")
        .single();
      orgId = newOrg?.id || null;
    }
  }

  // 4. Ensure investigators exist and are linked
  const piDetails: any[] = projectData.piDetails || [];
  for (const pi of piDetails) {
    const piName = (pi.fullName || "").trim();
    if (!piName) continue;

    // Find existing investigator: try exact match first, then fuzzy
    // first+last token match so RePORTER variants like "Patrick T McGrath"
    // resolve to a curated "Patrick McGrath" row (preserving its email).
    const normalized = piName.replace(/\s+/g, " ").trim();
    const tokens = normalized.split(" ").filter(Boolean);
    const firstTok = tokens[0]?.toLowerCase() || "";
    const lastTok = tokens[tokens.length - 1]?.toLowerCase() || "";

    let existingInv: { id: string; resource_id: string | null } | null = null;
    const { data: exact } = await supabase
      .from("investigators")
      .select("id, resource_id")
      .ilike("name", normalized)
      .maybeSingle();
    existingInv = exact || null;

    if (!existingInv && firstTok && lastTok) {
      const { data: candidates } = await supabase
        .from("investigators")
        .select("id, resource_id, name, email")
        .ilike("name", `${firstTok}%${lastTok}`);
      const match = (candidates || []).find((c: any) => {
        const t = (c.name || "").replace(/\s+/g, " ").trim().toLowerCase().split(" ");
        return t[0] === firstTok && t[t.length - 1] === lastTok;
      });
      // Prefer the variant that already has an email
      const withEmail = (candidates || []).find((c: any) => {
        const t = (c.name || "").replace(/\s+/g, " ").trim().toLowerCase().split(" ");
        return t[0] === firstTok && t[t.length - 1] === lastTok && c.email;
      });
      existingInv = (withEmail || match) ? { id: (withEmail || match).id, resource_id: (withEmail || match).resource_id } : null;
    }

    let invId: string;
    if (existingInv) {
      invId = existingInv.id;
    } else {
      // Create resource node for investigator
      const { data: invResource } = await supabase
        .from("resources")
        .insert({
          name: piName,
          resource_type: "investigator",
        })
        .select("id")
        .single();

      const { data: newInv } = await supabase
        .from("investigators")
        .insert({
          name: piName,
          resource_id: invResource?.id || null,
        })
        .select("id")
        .single();

      if (!newInv) continue;
      invId = newInv.id;

      console.log(`Created investigator: ${piName} (${invId})`);
    }

    // Link investigator to organization
    if (orgId) {
      const { data: existingLink } = await supabase
        .from("investigator_organizations")
        .select("investigator_id")
        .eq("investigator_id", invId)
        .eq("organization_id", orgId)
        .maybeSingle();

      if (!existingLink) {
        await supabase
          .from("investigator_organizations")
          .insert({ investigator_id: invId, organization_id: orgId });
      }
    }

    // Stash the resolved investigator id on the PI record for the
    // shared sync pass below.
    pi.__invId = invId;
  }

  // Centralised PI reconciliation (curator entries are preserved).
  const reporterPis: ReporterPi[] = piDetails
    .filter((pi: any) => pi.__invId)
    .map((pi: any) => ({
      investigatorId: pi.__invId,
      name: pi.fullName || "",
      isContactPi: !!pi.isContactPi,
    }));
  await syncReporterPis(supabase, grantId, grantNumber, reporterPis);

  // 5. Ensure project metadata row exists
  const { data: existingProject } = await supabase
    .from("projects")
    .select("id")
    .eq("grant_number", grantNumber)
    .maybeSingle();

  if (!existingProject) {
    await supabase
      .from("projects")
      .insert({
        grant_number: grantNumber,
        grant_id: grantId,
      });
    console.log(`Created project metadata for ${grantNumber}`);
  }
}

// ─── Main handler ───────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Everything this function writes comes from NIH RePORTER, so it declares G1 (Constitution XI).
  // Without the declaration a service-role write resolves to G8 'unknown' and the provenance guard
  // would refuse it the moment a human had edited the same cell — which would silently stop
  // RePORTER refreshes on exactly the grants someone had curated. Declaring is both true and what
  // keeps the refresh working.
  //
  // Set on this server-side client only: a global header on the BROWSER client once broke every
  // edge function's CORS allow-list. Server-to-PostgREST has no preflight.
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    global: {
      headers: {
        "x-bbqs-source-class": "authoritative_registry",
        "x-bbqs-client": "nih-grants",
      },
    },
  });

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    // ACTION: reconcile — fast PI-only sync from RePORTER. Skips publication
    // fetches so it's safe to run on a cron without overrunning function
    // time limits. Used by the weekly pg_cron job.
    if (action === "reconcile") {
      const grantNumbers = await loadGrantNumbers(supabase);
      console.log(`Reconciling PIs for ${grantNumbers.length} grants...`);
      let synced = 0;
      const errors: string[] = [];

      for (const grantNumber of grantNumbers) {
        try {
          // Light fetch: project + PI list only
          const res = await fetch("https://api.reporter.nih.gov/v2/projects/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              criteria: { project_nums: [grantNumber] },
              include_fields: ["ProjectNum", "PrincipalInvestigators"],
              offset: 0,
              limit: 1,
            }),
          });
          if (!res.ok) {
            errors.push(`${grantNumber}: HTTP ${res.status}`);
            continue;
          }
          const json = await res.json();
          const project = json?.results?.[0];
          if (!project) continue;

          const { data: grantRow } = await supabase
            .from("grants").select("id").eq("grant_number", grantNumber).maybeSingle();
          if (!grantRow) continue;

          const pis = project.principal_investigators || [];
          const reporterPis: ReporterPi[] = [];
          for (const pi of pis) {
            const piName = (pi.full_name || "").trim();
            if (!piName) continue;
            const { data: inv } = await supabase
              .from("investigators").select("id").ilike("name", piName).maybeSingle();
            if (!inv) continue; // don't auto-create here; refresh handles that
            reporterPis.push({
              investigatorId: inv.id,
              name: piName,
              isContactPi: !!pi.is_contact_pi,
            });
          }
          await syncReporterPis(supabase, grantRow.id, grantNumber, reporterPis);
          synced++;
          await new Promise((r) => setTimeout(r, 100));
        } catch (err) {
          errors.push(`${grantNumber}: ${err instanceof Error ? err.message : "unknown"}`);
        }
      }

      return new Response(
        JSON.stringify({ success: true, reconciled: synced, errors: errors.length, errorDetails: errors }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }


    // ACTION: refresh — full pipeline: fetch from NIH APIs, seed all entities
    if (action === "refresh") {
      const grantNumbers = await loadGrantNumbers(supabase);
      console.log(`Refreshing ${grantNumbers.length} grants (full pipeline)...`);

      let updatedCount = 0;
      const errors: string[] = [];

      for (const grant of grantNumbers) {
        try {
          const projectData = await fetchGrantData(grant);
          if (projectData) {
            await seedGrantEntities(supabase, grant, projectData);
            updatedCount++;
          }
          await new Promise(resolve => setTimeout(resolve, 150));
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown";
          errors.push(`${grant}: ${msg}`);
          console.error(`Error seeding ${grant}:`, msg);
        }
      }

      console.log(`Refresh complete: ${updatedCount} grants fully seeded, ${errors.length} errors`);

      return new Response(
        JSON.stringify({ success: true, updated: updatedCount, errors: errors.length, errorDetails: errors }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // DEFAULT: serve grant data from grants table with full joins
    const { data: grants, error: grantsError } = await supabase
      .from("grants")
      .select("*")
      .order("grant_number");

    if (grantsError) {
      throw new Error(`Grants read error: ${grantsError.message}`);
    }

    // If no grants, do full initial seed
    if (!grants || grants.length === 0) {
      console.log("No grants found, performing initial full seed...");

      const results = [];
      for (const grant of GRANT_NUMBERS) {
        const projectData = await fetchGrantData(grant);
        if (projectData) {
          await seedGrantEntities(supabase, grant, projectData);
          results.push(projectData);
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      return new Response(
        JSON.stringify({ success: true, data: results, source: "fresh" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch investigators with their organizations for all grants
    const grantIds = grants.map(g => g.id);
    const { data: grantInvestigators } = await supabase
      .from("grant_investigators")
      .select("grant_id, role, investigator_id")
      .in("grant_id", grantIds);

    const investigatorIds = [...new Set((grantInvestigators || []).map(gi => gi.investigator_id))];

    const { data: investigators } = investigatorIds.length > 0
      ? await supabase.from("investigators").select("id, name, email, orcid, scholar_id").in("id", investigatorIds)
      : { data: [] };

    const { data: invOrgs } = investigatorIds.length > 0
      ? await supabase.from("investigator_organizations").select("investigator_id, organization_id").in("investigator_id", investigatorIds)
      : { data: [] };

    const orgIds = [...new Set((invOrgs || []).map(io => io.organization_id))];
    const { data: organizations } = orgIds.length > 0
      ? await supabase.from("organizations").select("id, name").in("id", orgIds)
      : { data: [] };

    // Build lookup maps
    const invMap = new Map((investigators || []).map(i => [i.id, i]));
    const orgMap = new Map((organizations || []).map(o => [o.id, o]));
    const invOrgMap = new Map<string, string[]>();
    (invOrgs || []).forEach(io => {
      const orgs = invOrgMap.get(io.investigator_id) || [];
      orgs.push(io.organization_id);
      invOrgMap.set(io.investigator_id, orgs);
    });

    // Publications come from the KG, in one query. This used to be one live RePORTER POST per
    // grant on EVERY page load — 32 calls to re-fetch what `publications` already stores, and
    // React Query's staleTime is per-browser, so it was a fresh fan-out for each visitor.
    // import-grant-publications is what keeps these rows current; run it on the cron, not here.
    const { data: pubLinks } = await supabase
      .from("project_publications")
      .select("publications(pmid, title, year, journal, authors, citations, rcr, keywords, pubmed_link), projects(grant_number)");

    const grantPubMap = new Map<string, any[]>();
    for (const link of (pubLinks || []) as any[]) {
      const grantNumber = link.projects?.grant_number;
      const p = link.publications;
      if (!grantNumber || !p) continue;
      const list = grantPubMap.get(grantNumber) || [];
      list.push({
        pmid: p.pmid ?? "",
        title: p.title || "Unknown",
        year: p.year || 0,
        journal: p.journal || "Unknown",
        authors: p.authors || "",
        citations: p.citations || 0,
        rcr: p.rcr || 0,
        keywords: p.keywords || [],
        pubmedLink: p.pubmed_link || (p.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/` : ""),
      });
      grantPubMap.set(grantNumber, list);
    }

    const unlinked = grants.filter(g => !grantPubMap.has(g.grant_number)).map(g => g.grant_number);
    if (unlinked.length > 0) {
      console.warn(`[nih-grants] ${unlinked.length} grants have no KG publications; run import-grant-publications: ${unlinked.join(", ")}`);
    }

    // Only roles considered PIs for the Projects page PI column.
    const PI_ROLES = new Set(["pi", "contact_pi", "co_pi", "mpi"]);
    // Collapse whitespace + lowercase for dedupe (handles "Sima  Mofakham" double-space twins).
    const piKey = (name: string) => (name || "").trim().replace(/\s+/g, " ").toLowerCase();

    const results = grants.map(g => {
      const gisAll = (grantInvestigators || []).filter(gi => gi.grant_id === g.id);
      // The roster is the authority on who is a PI (#283), whoever recorded it. This used to also
      // require role_source === 'reporter', to keep "curator-added entries" off the page — but
      // role_source was never in the select above, so the test read undefined, defaulted to
      // 'reporter' and passed everything. Making it work would have deleted 7 PI rows, among them
      // the CONTACT PI of U01MH144347 (SMART-DBS) and of R61MH138612 (SeeMe), plus both MPIs of
      // R34DA062119 (ARC) — all real. Removing it is a no-op today and stops a later "fix".
      const gis = gisAll.filter(gi => PI_ROLES.has((gi.role || "").toLowerCase()));
      const rawPiDetails = gis.map(gi => {
        const inv = invMap.get(gi.investigator_id);
        return {
          fullName: inv?.name || "Unknown",
          firstName: (inv?.name || "").split(" ")[0] || "",
          lastName: (inv?.name || "").split(" ").slice(-1)[0] || "",
          profileId: null,
          isContactPi: gi.role === "contact_pi",
        };
      });
      // Dedupe by normalized name, preferring the contact_pi variant if present.
      const byKey = new Map<string, typeof rawPiDetails[number]>();
      for (const pi of rawPiDetails) {
        const k = piKey(pi.fullName);
        if (!k) continue;
        const prev = byKey.get(k);
        if (!prev || (pi.isContactPi && !prev.isContactPi)) {
          byKey.set(k, { ...pi, fullName: pi.fullName.replace(/\s+/g, " ").trim() });
        }
      }
      const piDetails = Array.from(byKey.values());

      const contactPi = piDetails.find(pi => pi.isContactPi);
      const allPiNames = piDetails.map(pi => pi.fullName).join(", ");

      let institution = "Unknown";
      const contactPiGi = gisAll.find(gi => gi.role === "contact_pi") || gis[0] || gisAll[0];
      if (contactPiGi) {
        const piOrgIds = invOrgMap.get(contactPiGi.investigator_id) || [];
        if (piOrgIds.length > 0) {
          const org = orgMap.get(piOrgIds[0]);
          if (org) institution = org.name;
        }
      }

      const pubs = grantPubMap.get(g.grant_number) || [];

      return {
        grantNumber: g.grant_number,
        title: g.title,
        abstract: g.abstract,
        contactPi: contactPi?.fullName || allPiNames.split(",")[0]?.trim() || "Unknown",
        allPis: allPiNames || "Unknown",
        piDetails: piDetails.length > 0 ? piDetails : undefined,
        institution,
        fiscalYear: g.fiscal_year,
        awardAmount: g.award_amount,
        nihLink: g.nih_link,
        publications: pubs,
        publicationCount: pubs.length,
      };
    });

    return new Response(
      JSON.stringify({ success: true, data: results, source: "grants_table" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in nih-grants function:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
