// Shared KG read layer for the external faces (bbqs-mcp, bbqs-api) — feature 009.
//
// ONE data truth: reads the LIVE KG under the ANON key (RLS is the authority). Never the
// service role on read paths. Auth is an explicit parameter (KgAuth) so a per-user token can
// be swapped in later (Phase 5 / BrainKB) without rework — only { anon: true } is wired now.
//
// SAFETY (R5): selects explicit PUBLIC columns only. PI names come from investigators_public
// (the email-free public view) — NEVER investigator_directory / investigators. The raw
// projects.metadata blob (internal onboarding fields) is never fetched or returned.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export type KgAuth = { anon: true } | { jwt: string };

function authBearer(auth: KgAuth): string {
  return "jwt" in auth ? auth.jwt : ANON_KEY;
}

/** GET the KG REST API under the given auth context (anon or a user JWT; RLS applies). */
async function kgGet<T = unknown>(pathAndQuery: string, auth: KgAuth): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${authBearer(auth)}` },
  });
  if (!res.ok) {
    throw new Error(`KG ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// ── Public shapes (see specs/009 data-model.md) ─────────────────────────────
export type PublicInvestigator = { name: string; role: string | null };
export type PublicProject = {
  grant_number: string;
  title: string | null;
  abstract_snippet: string | null;
  study_species: string[];
  keywords: string[];
  website: string | null;
  investigators: PublicInvestigator[];
};
export type SpeciesAggregate = { species: string; projectCount: number; projects: string[] };

const enc = encodeURIComponent;
const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

type ProjRow = {
  grant_number: string | null;
  grant_id: string | null;
  study_species: string[] | null;
  keywords: string[] | null;
  website: string | null;
  grants: { title: string | null; abstract: string | null } | null;
};

// Explicit public column list — NEVER select=* (would drag in projects.metadata internals).
const PROJECT_SELECT =
  "grant_number,grant_id,study_species,keywords,website,grants(title,abstract)";

/** Fetch all projects (30-scale) + attach their investigators (name+role) from the
 *  anon-safe public view. Three bounded queries, all anon. */
async function loadProjects(auth: KgAuth): Promise<PublicProject[]> {
  const rows = await kgGet<ProjRow[]>(`projects?select=${PROJECT_SELECT}&limit=1000`, auth);

  const grantIds = [...new Set(rows.map((r) => r.grant_id).filter(Boolean))] as string[];
  const giByGrant = new Map<string, { investigator_id: string; role: string | null }[]>();
  const invIds = new Set<string>();
  if (grantIds.length) {
    const gi = await kgGet<{ grant_id: string; investigator_id: string; role: string | null }[]>(
      `grant_investigators?grant_id=in.(${grantIds.map(enc).join(",")})&select=grant_id,investigator_id,role&limit=1000`,
      auth,
    );
    for (const r of gi) {
      if (!r.investigator_id) continue;
      invIds.add(r.investigator_id);
      const list = giByGrant.get(r.grant_id) ?? [];
      list.push({ investigator_id: r.investigator_id, role: r.role });
      giByGrant.set(r.grant_id, list);
    }
  }

  const nameById = new Map<string, string>();
  if (invIds.size) {
    // investigators_public: the EMAIL-FREE public view (no institution field either).
    const invs = await kgGet<{ id: string; name: string | null }[]>(
      `investigators_public?id=in.(${[...invIds].map(enc).join(",")})&select=id,name&limit=1000`,
      auth,
    );
    for (const i of invs) if (i.name) nameById.set(i.id, i.name);
  }

  return rows
    .filter((r) => r.grant_number)
    .map((r) => {
      const gi = (r.grant_id && giByGrant.get(r.grant_id)) || [];
      const investigators = gi
        .map((g) => ({ name: nameById.get(g.investigator_id) ?? "", role: g.role }))
        .filter((x) => x.name);
      const abstract = r.grants?.abstract ?? null;
      return {
        grant_number: r.grant_number!,
        title: r.grants?.title ?? null,
        abstract_snippet: abstract ? abstract.slice(0, 400) : null,
        study_species: asArray(r.study_species),
        keywords: asArray(r.keywords),
        website: r.website,
        investigators,
      };
    });
}

/** Semantic project hits (grant_numbers, best-first) via the unified KG index. Anon RPC. */
async function semanticProjectIds(query: string, auth: KgAuth, count = 20): Promise<string[]> {
  const vec = await embedText(query);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_knowledge_embeddings`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${authBearer(auth)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query_embedding: `[${vec.join(",")}]`,
      match_threshold: 0.3,
      match_count: count,
    }),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as { source_type: string; source_id: string }[];
  return rows.filter((r) => r.source_type === "project").map((r) => r.source_id);
}

// ── Public API used by the faces ────────────────────────────────────────────

export async function searchProjects(
  params: { species?: string; pi?: string; query?: string },
  auth: KgAuth,
): Promise<{ count: number; projects: PublicProject[] }> {
  let projects = await loadProjects(auth);

  if (params.species) {
    const s = params.species.toLowerCase();
    projects = projects.filter((p) => p.study_species.some((x) => x.toLowerCase().includes(s)));
  }
  if (params.pi) {
    const q = params.pi.toLowerCase();
    projects = projects.filter((p) => p.investigators.some((i) => i.name.toLowerCase().includes(q)));
  }
  if (params.query && params.query.trim()) {
    const order = await semanticProjectIds(params.query, auth);
    if (order.length) {
      const rank = new Map(order.map((gn, i) => [gn, i]));
      projects = projects
        .filter((p) => rank.has(p.grant_number))
        .sort((a, b) => (rank.get(a.grant_number)! - rank.get(b.grant_number)!));
    } else {
      // Semantic unavailable → lexical fallback over public text.
      const q = params.query.toLowerCase();
      projects = projects.filter(
        (p) =>
          (p.title ?? "").toLowerCase().includes(q) ||
          (p.abstract_snippet ?? "").toLowerCase().includes(q) ||
          p.keywords.some((k) => k.toLowerCase().includes(q)),
      );
    }
  }
  return { count: projects.length, projects };
}

export async function getProject(grantNumber: string, auth: KgAuth): Promise<PublicProject | null> {
  const all = await loadProjects(auth);
  return all.find((p) => p.grant_number === grantNumber) ?? null;
}

export async function listSpecies(auth: KgAuth): Promise<{ species: SpeciesAggregate[] }> {
  const projects = await loadProjects(auth);
  const map = new Map<string, SpeciesAggregate>();
  for (const p of projects) {
    for (const sp of p.study_species) {
      const key = sp.trim();
      if (!key) continue;
      const agg = map.get(key) ?? { species: key, projectCount: 0, projects: [] };
      agg.projectCount++;
      agg.projects.push(p.title ?? p.grant_number);
      map.set(key, agg);
    }
  }
  return { species: [...map.values()].sort((a, b) => b.projectCount - a.projectCount) };
}

// ── Embedding (OpenRouter, unified model) — shared with rag.ts ───────────────
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
export async function embedText(text: string): Promise<number[]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://bbqs.dev",
    },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error(`Embedding error: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.data[0].embedding as number[];
}

export { SUPABASE_URL, ANON_KEY, authBearer };
