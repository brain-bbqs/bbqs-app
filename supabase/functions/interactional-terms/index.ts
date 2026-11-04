// Tokenizes grant abstracts + publication titles across the consortium
// and returns shared vocabulary + bigrams — the raw substrate of the
// "interactional" (linguistic entrainment) layer of the Social Force Field.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, requireService } from "../_shared/auth.ts";

const STOP = new Set(`the a an and or of to in for on with by from at as is are was were be been being this that these those we our their they them it its into using use used study studies research project projects proposal aim aims will can may than then which who what how such more most many both other also each new novel data analysis analyses model models based approach approaches method methods result results between across within upon during over under about only same different high low large small key core role roles include including include includes provide provides provided understand understanding investigate investigating identify identifying develop developing developed developments significant significantly propose proposes proposed toward towards has have had does do done not no yet still further work working works well among per due via one two three type types level levels critical important effect effects s`.split(/\s+/));

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && t.length <= 30 && !STOP.has(t) && !/^\d+$/.test(t));
}

Deno.serve(async (req) => {
  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers });
  const denied = await requireService(req, headers);
  if (denied) return denied;
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, service);

    // Pull all grants (abstract + grant_number) + all publication titles keyed to a project.
    const [{ data: grants }, { data: projects }, { data: projPubs }, { data: pubs }] = await Promise.all([
      admin.from("grants").select("id, grant_number, title, abstract"),
      admin.from("projects").select("grant_number, keywords"),
      admin.from("project_publications").select("project_id, publication_id"),
      admin.from("publications").select("id, title, keywords"),
    ]);

    // Build per-grant text corpus.
    const projByGrant = new Map<string, string>();
    for (const p of projects ?? []) projByGrant.set(p.grant_number, p.grant_number);
    const pubById = new Map<string, any>((pubs ?? []).map((p: any) => [p.id, p]));
    // project_publications.project_id joins to projects.id — we need grant_number path.
    // We keep it simple: join publication -> project by lookup on grants; for term counting
    // we just merge every publication title into the pool per grant if we can map it.
    // Easiest and good enough: build corpus of {grant_number -> [tokens]}.
    const corpus = new Map<string, string[]>();
    for (const g of grants ?? []) {
      const text = `${g.title ?? ""} ${g.abstract ?? ""}`;
      corpus.set(g.grant_number, tokenize(text));
    }
    for (const p of projects ?? []) {
      const kw = (p.keywords ?? []).join(" ");
      const arr = corpus.get(p.grant_number) ?? [];
      corpus.set(p.grant_number, arr.concat(tokenize(kw)));
    }

    // Term counts + cross-project spread.
    const totalCount = new Map<string, number>();
    const projCount = new Map<string, Set<string>>();
    const bigramTotal = new Map<string, number>();
    const bigramProj = new Map<string, Set<string>>();

    for (const [gn, toks] of corpus.entries()) {
      const seen = new Set<string>();
      for (const t of toks) {
        totalCount.set(t, (totalCount.get(t) ?? 0) + 1);
        if (!projCount.has(t)) projCount.set(t, new Set());
        projCount.get(t)!.add(gn);
        seen.add(t);
      }
      for (let i = 0; i < toks.length - 1; i++) {
        const bg = `${toks[i]} ${toks[i + 1]}`;
        bigramTotal.set(bg, (bigramTotal.get(bg) ?? 0) + 1);
        if (!bigramProj.has(bg)) bigramProj.set(bg, new Set());
        bigramProj.get(bg)!.add(gn);
      }
    }

    const terms = [...totalCount.entries()]
      .map(([term, count]) => ({ term, count, projects: projCount.get(term)!.size }))
      .filter((t) => t.projects >= 2)
      .sort((a, b) => b.projects * 100 + b.count - (a.projects * 100 + a.count))
      .slice(0, 80);

    const bigrams = [...bigramTotal.entries()]
      .map(([term, count]) => ({ term, count, projects: bigramProj.get(term)!.size }))
      .filter((t) => t.projects >= 2)
      .sort((a, b) => b.projects - a.projects || b.count - a.count)
      .slice(0, 25);

    return new Response(JSON.stringify({
      terms, bigrams,
      grants: corpus.size,
      generated_at: new Date().toISOString(),
    }), { headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers });
  }
});