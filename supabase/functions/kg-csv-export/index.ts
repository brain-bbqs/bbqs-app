// KG-ready CSV export for the consortium graph lifter.
// Emits people.csv or publications.csv with columns aligned 1:1 to the TriG
// schema in docs/kg-csv-schema.md.  Admin-only.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, requireAdmin } from "../_shared/auth.ts";

const TENANT = "consortium-alpha";
const INGESTION_AGENT = "crossref-ingestion-agent";

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(cols: string[], rows: Record<string, unknown>[]): string {
  const head = cols.join(",");
  const body = rows.map((r) => cols.map((c) => csvEscape(r[c])).join(",")).join("\n");
  return head + "\n" + body + "\n";
}

const PEOPLE_COLS = [
  "person_id", "name", "orcid", "email_primary", "institution_name",
  "role", "working_groups", "scholar_id", "reporter_profile_id", "profile_url",
  "tenant", "security_label", "access_policy",
  "claim_status", "confidence", "evidence_source", "asserted_in", "generated_at",
];

const PUB_COLS = [
  "publication_id", "doi", "pmid", "title", "journal", "year",
  "authors_raw", "author_orcids", "citations", "rcr", "keywords", "url",
  "tenant", "security_label", "access_policy",
  "claim_status", "confidence", "evidence_source", "ingestion_agent", "generated_at",
];

function orcidList(json: unknown): string {
  if (!json) return "";
  const arr = Array.isArray(json) ? json : (typeof json === "object" ? Object.values(json as object) : []);
  return arr
    .map((v) => (typeof v === "string" ? v : (v as any)?.orcid ?? (v as any)?.id ?? ""))
    .filter(Boolean)
    .join(";");
}

async function peopleCsv(supabase: ReturnType<typeof createClient>): Promise<string> {
  const { data, error } = await supabase
    .from("investigators")
    .select("id, name, orcid, email, institution, role, working_groups, scholar_id, reporter_profile_id, profile_url, updated_at")
    .order("name", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []).map((r: any) => ({
    person_id: r.id,
    name: r.name,
    orcid: r.orcid ?? "",
    email_primary: r.email ?? "",
    institution_name: r.institution ?? "",
    role: r.role ?? "",
    working_groups: Array.isArray(r.working_groups) ? r.working_groups.join(";") : "",
    scholar_id: r.scholar_id ?? "",
    reporter_profile_id: r.reporter_profile_id ?? "",
    profile_url: r.profile_url ?? "",
    tenant: TENANT,
    security_label: "Internal",
    access_policy: "policy-consortium-read",
    claim_status: "",
    confidence: "",
    evidence_source: "",
    asserted_in: "",
    generated_at: r.updated_at ?? "",
  }));
  return toCsv(PEOPLE_COLS, rows);
}

async function publicationsCsv(supabase: ReturnType<typeof createClient>): Promise<string> {
  const { data, error } = await supabase
    .from("publications")
    .select("id, doi, pmid, title, journal, year, authors, author_orcids, citations, rcr, keywords, pubmed_link, updated_at")
    .order("year", { ascending: false, nullsFirst: false });
  if (error) throw error;
  const rows = (data ?? []).map((r: any) => {
    const orcids = orcidList(r.author_orcids);
    const evidence = r.doi ? `https://doi.org/${r.doi}` : "";
    return {
      publication_id: r.id,
      doi: r.doi ?? "",
      pmid: r.pmid ?? "",
      title: r.title ?? "",
      journal: r.journal ?? "",
      year: r.year ?? "",
      authors_raw: r.authors ?? "",
      author_orcids: orcids,
      citations: r.citations ?? "",
      rcr: r.rcr ?? "",
      keywords: Array.isArray(r.keywords) ? r.keywords.join(";") : "",
      url: r.pubmed_link ?? evidence,
      tenant: TENANT,
      security_label: "Public",
      access_policy: "policy-public-read",
      claim_status: r.doi && orcids ? "Verified" : "",
      confidence: "",
      evidence_source: evidence,
      ingestion_agent: INGESTION_AGENT,
      generated_at: r.updated_at ?? "",
    };
  });
  return toCsv(PUB_COLS, rows);
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = await requireAdmin(req, cors);
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const entity = url.searchParams.get("entity") ?? "people";
  if (entity !== "people" && entity !== "publications") {
    return new Response(JSON.stringify({ error: "entity must be 'people' or 'publications'" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const csv = entity === "people" ? await peopleCsv(supabase) : await publicationsCsv(supabase);
    const filename = `bbqs-${entity}-kg-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(csv, {
      headers: {
        ...cors,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
