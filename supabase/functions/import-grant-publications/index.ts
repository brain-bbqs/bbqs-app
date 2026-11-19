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
// Idempotent: a paper is recognised by its PMID key, then its DOI key (_shared/kg-write.ts, the keys
// the uq_publications_* indexes refuse a second row by), and links by (project_id, publication_id),
// so it is safe to re-run. Each paper it touches is given its KG node (a spine row) if it has none,
// and a preprint is linked to its published version (resource_links revision_of) by
// public.kg_link_publication_versions(), once 20261117181500 is applied; before that the result says
// version_links "unavailable". Run for one grant (POST { "grant_number": "U24MH136628" }) or all
// consortium grants (no body).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bearerOf, getCorsHeaders, isServiceRole, requireAdmin } from "../_shared/auth.ts";
import { awardKey, nihAwardCore } from "../_shared/identity-keys.ts";
import {
  ensureSpineRow, findOrCreatePublication, isUniqueViolation, kgSession, linkPublicationVersions,
  VERSION_LINKS_UNAVAILABLE, type KgSession, type VersionLinks,
} from "../_shared/kg-write.ts";

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

// The NIH core ('1R34DA059506-01' -> 'R34DA059506'), the key RePORTER's core_project_nums takes and
// the one that produced the count on the list page. A number that is not NIH-shaped is sent as stored.
function coreProjectNumFor(grantNumber: string): string {
  return nihAwardCore(grantNumber) ?? grantNumber.trim();
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
// Through _shared/kg-write.ts: a paper already in the KG is reused, never copied; a new one is
// inserted; either way it gets its node, so a preprint and its published version can be linked
// (two records joined by revision_of, never merged into one).

interface GrantResult {
  grant_number: string;
  project_id: string | null;
  reporter_count: number;
  pubs_created: number;
  pubs_reused: number;
  /** How each reused paper was recognised. */
  pubs_matched: { pmid: number; doi: number };
  spine_rows_created: number;
  links_created: number;
  links_existing: number;
  /** The revision_of links for this grant's papers, or why there are none. */
  version_links: VersionLinks | string | null;
  /** Papers the KG already held under another write, or under two records (a PMID and a DOI). */
  already_in_kg: string[];
  skipped?: string;
}

const emptyResult = (grantNumber: string, projectId: string | null): GrantResult => ({
  grant_number: grantNumber,
  project_id: projectId,
  reporter_count: 0,
  pubs_created: 0,
  pubs_reused: 0,
  pubs_matched: { pmid: 0, doi: 0 },
  spine_rows_created: 0,
  links_created: 0,
  links_existing: 0,
  version_links: null,
  already_in_kg: [],
});

async function importForProject(kg: KgSession, grantNumber: string, projectId: string): Promise<GrantResult> {
  const result = emptyResult(grantNumber, projectId);
  const pubs = await fetchPublicationsForGrant(grantNumber);
  result.reporter_count = pubs.length;
  const papers: string[] = [];

  for (const pub of pubs) {
    const found = await findOrCreatePublication(kg, {
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
    });
    if (!found.ok) {
      console.error(`Publication PMID=${pub.pmid} not written: ${found.error}`);
      if (found.already_in_kg) result.already_in_kg.push(found.error);
      continue;
    }
    const paper = found.row;
    if (found.note) result.already_in_kg.push(`PMID ${pub.pmid}: ${found.note}`);
    if (found.created) {
      result.pubs_created++;
    } else {
      result.pubs_reused++;
      if (found.matchedBy === "pmid" || found.matchedBy === "doi") result.pubs_matched[found.matchedBy]++;
      // Refresh only volatile citation metrics; leave curator-editable fields alone.
      await kg.db.from("publications").update({ citations: pub.citations, rcr: pub.rcr }).eq("id", paper.id);
    }

    // Its node: a paper without one is not in the graph, and cannot be linked to its other version.
    const spine = await ensureSpineRow(kg, "publications", paper, {
      name: paper.title || pub.title || "Unknown",
      resource_type: "publication",
      external_url: pub.pubmedLink || null,
    });
    if (spine.created) result.spine_rows_created++;
    else if (!spine.ok) console.error(`No node for PMID=${pub.pmid}: ${spine.error}`);
    papers.push(paper.id);

    // Link to project (idempotent: check-then-insert; a 23505 means another run linked it first).
    const { data: link } = await kg.db
      .from("project_publications")
      .select("publication_id")
      .eq("project_id", projectId)
      .eq("publication_id", paper.id)
      .maybeSingle();

    if (link) {
      result.links_existing++;
    } else {
      const { error: linkErr } = await kg.db
        .from("project_publications")
        .insert({ project_id: projectId, publication_id: paper.id });
      if (!linkErr) result.links_created++;
      else if (isUniqueViolation(linkErr)) result.links_existing++;
      else console.error(`Link insert failed (${grantNumber} -> ${paper.id}):`, linkErr.message);
    }
  }

  // Now that each of this grant's papers is a node: link each preprint to its published version.
  const versions = await linkPublicationVersions(kg.db, papers);
  result.version_links = versions.available ? versions : (versions.note ?? VERSION_LINKS_UNAVAILABLE);
  if (versions.error) console.error(`Version links for ${grantNumber}: ${versions.error}`);
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
  if (!(await isServiceRole(bearerOf(req)))) {
    const auth = await requireAdmin(req, corsHeaders);
    if (auth.error) return auth.error;
  }

  try {
    // Named on this server-side client (Principle X): without it these service-role writes read
    // 'unknown' in data_audit_log. No source-class header: declaring one is a separate decision that
    // raises what the importer may overwrite (20260831160000).
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { "x-bbqs-client": "import-grant-publications" } } },
    );
    const kg = kgSession(admin);

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
    // project_id that `project_publications` links to. A grant is found by its award key, so
    // '1U24MH136628-01' finds the project stored as U24MH136628.
    const { data: allProjects, error: projErr } = await admin.from("projects").select("id, grant_number");
    if (projErr) throw new Error(`Failed to read projects: ${projErr.message}`);
    const projects = grantNumberFilter
      ? (allProjects ?? []).filter((p: { grant_number: string }) => awardKey(p.grant_number) === awardKey(grantNumberFilter))
      : allProjects;

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
        results.push(await importForProject(kg, project.grant_number, project.id));
      } catch (err) {
        console.error(`Import failed for ${project.grant_number}:`, err);
        results.push({
          ...emptyResult(project.grant_number, project.id),
          skipped: err instanceof Error ? err.message : "unknown error",
        });
      }
      // Be polite to the NIH APIs between grants.
      await new Promise((r) => setTimeout(r, 150));
    }

    const sum = (f: (r: GrantResult) => number) => results.reduce((n, r) => n + f(r), 0);
    const linked = (k: "done" | "noop" | "skipped") =>
      sum((r) => (r.version_links && typeof r.version_links === "object" ? r.version_links[k] : 0));
    const unavailable = results.find((r) => typeof r.version_links === "string")?.version_links;
    const totals = {
      reporter_count: sum((r) => r.reporter_count),
      pubs_created: sum((r) => r.pubs_created),
      pubs_reused: sum((r) => r.pubs_reused),
      pubs_matched: { pmid: sum((r) => r.pubs_matched.pmid), doi: sum((r) => r.pubs_matched.doi) },
      spine_rows_created: sum((r) => r.spine_rows_created),
      links_created: sum((r) => r.links_created),
      links_existing: sum((r) => r.links_existing),
      version_links: unavailable ?? { done: linked("done"), noop: linked("noop"), skipped: linked("skipped") },
      already_in_kg: sum((r) => r.already_in_kg.length),
    };

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
