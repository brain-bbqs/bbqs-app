// Computes an N×N Jaccard similarity matrix across BBQS projects using
// species / approaches / sensors / data modalities / analysis methods /
// keywords. Powers the Relational (macro) layer of the Social Force Field.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, requireService } from "../_shared/auth.ts";

function jaccard(a: string[], b: string[]): number {
  if (!a?.length || !b?.length) return 0;
  const A = new Set(a.map((s) => s.toLowerCase().trim()));
  const B = new Set(b.map((s) => s.toLowerCase().trim()));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

Deno.serve(async (req) => {
  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers });
  const denied = requireService(req, headers);
  if (denied) return denied;
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, service);
    const { data: projects } = await admin
      .from("projects")
      .select("grant_number, study_species, keywords, metadata");
    const { data: grants } = await admin.from("grants").select("grant_number, title");
    const titleMap = new Map((grants ?? []).map((g: any) => [g.grant_number, g.title as string]));

    const FIELDS = ["study_species", "use_approaches", "use_sensors", "produce_data_modality", "use_analysis_method", "keywords"] as const;
    const TOP = new Set(["study_species", "keywords"]);
    const get = (p: any, f: string): string[] =>
      TOP.has(f) ? (p[f] ?? []) : ((p.metadata ?? {})[f] ?? []);

    const rows = (projects ?? []).map((p: any) => ({
      grant_number: p.grant_number,
      title: titleMap.get(p.grant_number) ?? p.grant_number,
      species: (p.study_species ?? []) as string[],
      fields: Object.fromEntries(FIELDS.map((f) => [f, get(p, f)])) as Record<string, string[]>,
    }));

    const n = rows.length;
    const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        if (i === j) { matrix[i][j] = 1; continue; }
        let s = 0;
        for (const f of FIELDS) s += jaccard(rows[i].fields[f], rows[j].fields[f]);
        const v = s / FIELDS.length;
        matrix[i][j] = v; matrix[j][i] = v;
      }
    }

    // Species coverage: species appearing in ≥2 projects
    const speciesCount = new Map<string, number>();
    for (const r of rows) {
      const uniq = new Set(r.species.map((s) => s.toLowerCase().trim()).filter(Boolean));
      for (const s of uniq) speciesCount.set(s, (speciesCount.get(s) ?? 0) + 1);
    }
    const speciesShared = [...speciesCount.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([species, count]) => ({ species, count }));

    // % of projects sharing ≥1 species with ≥1 other project
    let connected = 0;
    for (let i = 0; i < n; i++) {
      const mine = new Set(rows[i].species.map((s) => s.toLowerCase().trim()));
      let has = false;
      for (let j = 0; j < n && !has; j++) {
        if (i === j) continue;
        for (const s of rows[j].species) if (mine.has(s.toLowerCase().trim())) { has = true; break; }
      }
      if (has) connected++;
    }
    const themeAlignment = n === 0 ? 0 : Math.round((connected / n) * 100);

    return new Response(JSON.stringify({
      labels: rows.map((r) => ({ grant_number: r.grant_number, title: r.title })),
      matrix,
      speciesShared,
      themeAlignment,
      projects: n,
    }), { headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers });
  }
});