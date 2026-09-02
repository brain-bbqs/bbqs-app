// Admin-only: reconcile NIH-RePORTER publications INTO the knowledge graph.
//
// PROBLEM this solves: the Projects LIST page reads live publication counts from
// NIH RePORTER (via the `nih-grants` function), but the grant DETAIL panel counts
// the KG `project_publications` table — which is empty for most/all grants. The two
// views therefore disagree (e.g. BARD.CC / U24MH136628 shows 2 on the list, 0 on
// the detail panel). This importer fetches the same RePORTER-reported publications
// the list uses and upserts them into `publications` + `project_publications`, so
// both views agree and the pubs become curatable KG nodes.
//
// Idempotent: dedupes publications by PMID (then DOI) and links by
// (project_id, publication_id), so it is safe to re-run. Run for one grant
// (POST { "grant_number": "U24MH136628" }) or all consortium grants (no body).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, requireAdmin } from "../_shared/auth.ts";

// ─── NIH / iCite / PubMed fetch helpers ────────────────────────
// Mirrors the logic in `nih-grants` so the publications we import are exactly
// the ones the list page counts — with one addition: we keep the DOI (the
// nih-grants list shape drops it) since the KG `publications` table stores it
// and we dedupe on it.

interface ReporterPub {
  pmid: string;
  doi: string;
  title: string;
  year: number;
  journal: string;
  authors: string;
  citations: number;
  rcr: number;
  keywords: string[];
  pubmedLink: string;
}

// Match the core_project_num derivation used by nih-grants' list handler so we
// query RePORTER with the same key that produced the count on the list page.
function coreProjectNumFor(grantNumber: string): string {
  return grantNumber.replace(/^\d+/, "").replace(/-\d+$/, "");
}

async function fetchReporterPmids(coreProjectNum: string): Promise<any[]> {
  const res = await fetch("https://api.reporter.nih.gov/v2/publications/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: { core_project_nums: [coreProjectNum] },
      offset: 0,
      limit: 100,
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

async function fetchICiteDetails(pmids: string[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  if (pmids.length === 0) return map;
  try {
    const res = await fetch(`https://icite.od.nih.gov/api/pubs?pmids=${pmids.join(",")}`);
    if (!res.ok) return map;
    const data = await res.json();
    const pubs = data.data || data;
    for (const pub of pubs) {
      map.set(String(pub.pmid), {
        title: pub.title || "Unknown",
        year: pub.year || 0,
        journal: pub.journal || "Unknown",
        authors: pub.authors || "",
        citations: pub.citation_count || 0,
        rcr: pub.relative_citation_ratio || 0,
        doi: pub.doi || "",
      });
    }
  } catch (err) {
    console.error("iCite fetch error:", err);
  }
  return map;
}

async function fetchPubMedKeywords(pmids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (pmids.length === 0) return map;
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
        while ((meshMatch = meshRegex.exec(article)) !== null) keywords.push(meshMatch[1]);
        const kwRegex = /<Keyword[^>]*>([^<]+)<\/Keyword>/g;
        let kwMatch;
        while ((kwMatch = kwRegex.exec(article)) !== null) {
          if (!keywords.includes(kwMatch[1])) keywords.push(kwMatch[1]);
        }
        map.set(pmid, keywords);
      }
      if (i + batchSize < pmids.length) await new Promise((r) => setTimeout(r, 200));
    }
  } catch (err) {
    console.error("PubMed keywords fetch error:", err);
  }
  return map;
}

async function fetchPublicationsForGrant(grantNumber: string): Promise<ReporterPub[]> {
  const coreProjectNum = coreProjectNumFor(grantNumber);
  const reporterPubs = await fetchReporterPmids(coreProjectNum);
  if (reporterPubs.length === 0) return [];

  const pmids = reporterPubs.map((p: any) => String(p.pmid)).filter(Boolean);
  const [details, keywords] = await Promise.all([
    fetchICiteDetails(pmids),
    fetchPubMedKeywords(pmids),
  ]);

  return reporterPubs.map((pub: any) => {
    const pmid = String(pub.pmid);
    const d = details.get(pmid) || {};
    return {
      pmid,
      doi: d.doi || "",
      title: d.title || "Unknown",
      year: d.year || 0,
      journal: d.journal || "Unknown",
      authors: d.authors || "",
      citations: d.citations || 0,
      rcr: d.rcr || 0,
      keywords: keywords.get(pmid) || [],
      pubmedLink: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
    };
  });
}

// ─── KG upsert ──────────────────────────────────────────────────

interface GrantResult {
  grant_number: string;
  project_id: string | null;
  reporter_count: number;
  pubs_created: number;
  pubs_reused: number;
  links_created: number;
  links_existing: number;
  skipped?: string;
}

// Upsert one publication (dedupe by PMID, then DOI) and return its id.
async function upsertPublication(admin: any, pub: ReporterPub): Promise<{ id: string; created: boolean } | null> {
  // 1. Dedupe by PMID.
  let existing: { id: string } | null = null;
  if (pub.pmid) {
    const { data } = await admin.from("publications").select("id").eq("pmid", pub.pmid).maybeSingle();
    if (data) existing = data;
  }
  // 2. Fall back to DOI (case-insensitive).
  if (!existing && pub.doi) {
    const { data } = await admin.from("publications").select("id").ilike("doi", pub.doi).maybeSingle();
    if (data) existing = data;
  }

  if (existing) {
    // Refresh only volatile citation metrics; leave curator-editable fields alone.
    await admin
      .from("publications")
      .update({ citations: pub.citations, rcr: pub.rcr })
      .eq("id", existing.id);
    return { id: existing.id, created: false };
  }

  const { data: inserted, error } = await admin
    .from("publications")
    .insert({
      pmid: pub.pmid || null,
      doi: pub.doi || null,
      title: pub.title || "Unknown",
      authors: pub.authors || null,
      journal: pub.journal || null,
      year: pub.year || null,
      citations: pub.citations || null,
      rcr: pub.rcr || null,
      keywords: pub.keywords.length ? pub.keywords : null,
      pubmed_link: pub.pubmedLink || null,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    console.error(`Failed to insert publication PMID=${pub.pmid}:`, error?.message);
    return null;
  }
  return { id: inserted.id, created: true };
}

async function importForProject(admin: any, grantNumber: string, projectId: string): Promise<GrantResult> {
  const result: GrantResult = {
    grant_number: grantNumber,
    project_id: projectId,
    reporter_count: 0,
    pubs_created: 0,
    pubs_reused: 0,
    links_created: 0,
    links_existing: 0,
  };

  const pubs = await fetchPublicationsForGrant(grantNumber);
  result.reporter_count = pubs.length;

  for (const pub of pubs) {
    const up = await upsertPublication(admin, pub);
    if (!up) continue;
    if (up.created) result.pubs_created++;
    else result.pubs_reused++;

    // Link to project (idempotent: check-then-insert, constraint-agnostic).
    const { data: link } = await admin
      .from("project_publications")
      .select("publication_id")
      .eq("project_id", projectId)
      .eq("publication_id", up.id)
      .maybeSingle();

    if (link) {
      result.links_existing++;
    } else {
      const { error: linkErr } = await admin
        .from("project_publications")
        .insert({ project_id: projectId, publication_id: up.id });
      if (linkErr) console.error(`Link insert failed (${grantNumber} -> ${up.id}):`, linkErr.message);
      else result.links_created++;
    }
  }

  return result;
}

// ─── Handler ────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Admin JWT, or the service-role key so pg_cron and the SQL editor can drive it:
  //   SELECT public.cron_invoke('import-grant-publications', '{}'::jsonb);
  // requireAdmin resolves a user via getUser(), which the service-role key is not — without this
  // the function was deployed, gated, and reachable by nothing: no UI calls it and no cron could.
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const isServiceRole = bearer.length > 0 && bearer === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!isServiceRole) {
    const auth = await requireAdmin(req, corsHeaders);
    if (auth.error) return auth.error;
  }

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Optional { grant_number } in the body scopes the import to one grant.
    let grantNumberFilter: string | null = null;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body && typeof body.grant_number === "string" && body.grant_number.trim()) {
          grantNumberFilter = body.grant_number.trim().toUpperCase();
        }
      } catch {
        // no body → import all
      }
    }

    // The `projects` table is the canonical consortium list and gives us the
    // project_id that `project_publications` links to.
    let query = admin.from("projects").select("id, grant_number");
    if (grantNumberFilter) query = query.eq("grant_number", grantNumberFilter);
    const { data: projects, error: projErr } = await query;
    if (projErr) throw new Error(`Failed to read projects: ${projErr.message}`);

    if (!projects || projects.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: grantNumberFilter
            ? `No project found for grant_number=${grantNumberFilter}`
            : "No projects found to import",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const results: GrantResult[] = [];
    for (const project of projects) {
      try {
        results.push(await importForProject(admin, project.grant_number, project.id));
      } catch (err) {
        console.error(`Import failed for ${project.grant_number}:`, err);
        results.push({
          grant_number: project.grant_number,
          project_id: project.id,
          reporter_count: 0,
          pubs_created: 0,
          pubs_reused: 0,
          links_created: 0,
          links_existing: 0,
          skipped: err instanceof Error ? err.message : "unknown error",
        });
      }
      // Be polite to the NIH APIs between grants.
      await new Promise((r) => setTimeout(r, 150));
    }

    const totals = results.reduce(
      (acc, r) => ({
        reporter_count: acc.reporter_count + r.reporter_count,
        pubs_created: acc.pubs_created + r.pubs_created,
        pubs_reused: acc.pubs_reused + r.pubs_reused,
        links_created: acc.links_created + r.links_created,
        links_existing: acc.links_existing + r.links_existing,
      }),
      { reporter_count: 0, pubs_created: 0, pubs_reused: 0, links_created: 0, links_existing: 0 },
    );

    return new Response(
      JSON.stringify({ success: true, grants: results.length, totals, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("import-grant-publications error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
