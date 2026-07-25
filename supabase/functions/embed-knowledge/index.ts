// Full-coverage embedding sync for the UNIFIED index (feature 008).
//
// Embeds every consortium entity into knowledge_embeddings with OpenAI
// text-embedding-3-small (via OpenRouter — the same model discovery-chat uses), so the
// KG-site AND the agent can share one index. Idempotent + additive: upserts on source_id,
// never deletes. Safe to re-run; schedule nightly. Complements discovery-chat's lazy
// write-back by proactively covering all types.
//
// verify_jwt = false (machine caller / cron). Needs OPENROUTER_API_KEY on the KG project.
//
// Ordering: this must reach full coverage BEFORE the agent is repointed off
// resource_embeddings (see specs/008 in bbqs-agent) — else searchKG's semantic recall drops.
//
// ⚠️ CUTOVER — source_id reconciliation. Legacy knowledge_embeddings keys projects by the
// full NIH award id (5R34DA059510-02); THIS sync uses the canonical bare grant_number
// (R34DA059510) + entity uuids. Running it WITHOUT first clearing the legacy rows would
// DUPLICATE projects. knowledge_embeddings is a derived index (regenerable), so the safe
// cutover is: TRUNCATE public.knowledge_embeddings; then invoke this once to rebuild.
// (KG-site discovery-chat search is degraded only for the minutes the rebuild takes.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function embed(text: string, apiKey: string): Promise<number[] | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text.slice(0, 8000) }),
    });
    if (!res.ok) { console.error("embed error", res.status, (await res.text()).slice(0, 200)); return null; }
    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch (e) {
    console.error("embed exception", e instanceof Error ? e.message : String(e));
    return null;
  }
}

const clean = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : String(v ?? "")).trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
  if (!OPENROUTER_API_KEY) return json({ ok: false, error: "OPENROUTER_API_KEY not set" }, 500);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Optional {types:[...]} to sync a subset; default all.
  const body = await req.json().catch(() => ({}));
  const only: string[] | null = Array.isArray(body?.types) && body.types.length ? body.types : null;
  const want = (t: string) => !only || only.includes(t);

  // Each source builds: source_type, a stable source_id, title, and the text to embed.
  // Projects use grant_number as source_id (covers the grant 1:1) to match searchKG.
  const docs: Array<{ source_type: string; source_id: string; title: string; content: string; metadata: Record<string, unknown> }> = [];

  if (want("project")) {
    const { data } = await supabase
      .from("projects")
      .select("grant_number, keywords, study_species, grants(title, abstract)")
      .limit(1000);
    for (const p of (data ?? []) as any[]) {
      const g = p.grants ?? {};
      const gn = clean(p.grant_number);
      if (!gn) continue;
      docs.push({
        source_type: "project", source_id: gn, title: g.title ?? gn,
        content: [g.title, g.abstract, clean(p.keywords), clean(p.study_species)].filter(Boolean).join(". "),
        metadata: { grant_number: gn, study_species: p.study_species ?? [] },
      });
    }
  }
  if (want("investigator")) {
    const { data } = await supabase
      .from("investigator_directory")
      .select("id, name, institution, research_areas, skills, role")
      .limit(1000);
    for (const i of (data ?? []) as any[]) {
      if (!i.id) continue;
      docs.push({
        source_type: "investigator", source_id: i.id, title: i.name ?? i.id,
        content: [i.name, i.institution, clean(i.research_areas), clean(i.skills), i.role].filter(Boolean).join(". "),
        metadata: { institution: i.institution ?? null },
      });
    }
  }
  if (want("publication")) {
    const { data } = await supabase.from("publications").select("id, title, authors, journal, year, keywords").limit(2000);
    for (const p of (data ?? []) as any[]) {
      if (!p.id) continue;
      docs.push({
        source_type: "publication", source_id: p.id, title: p.title ?? p.id,
        content: [p.title, clean(p.authors), p.journal, clean(p.keywords)].filter(Boolean).join(". "),
        metadata: { year: p.year ?? null },
      });
    }
  }
  if (want("resource")) {
    const { data } = await supabase.from("resources").select("id, name, description, resource_type, external_url").limit(2000);
    for (const r of (data ?? []) as any[]) {
      if (!r.id) continue;
      docs.push({
        source_type: "resource", source_id: r.id, title: r.name ?? r.id,
        content: [r.name, r.description, r.resource_type].filter(Boolean).join(". "),
        metadata: { resource_type: r.resource_type ?? null, external_url: r.external_url ?? null },
      });
    }
  }
  if (want("organization")) {
    const { data } = await supabase.from("organizations").select("id, name, url").limit(1000);
    for (const o of (data ?? []) as any[]) {
      if (!o.id) continue;
      docs.push({ source_type: "organization", source_id: o.id, title: o.name ?? o.id, content: clean(o.name), metadata: {} });
    }
  }
  if (want("announcement")) {
    const { data } = await supabase.from("announcements").select("id, title, content").limit(1000);
    for (const a of (data ?? []) as any[]) {
      if (!a.id) continue;
      docs.push({ source_type: "announcement", source_id: a.id, title: a.title ?? a.id, content: [a.title, a.content].filter(Boolean).join(". "), metadata: {} });
    }
  }

  let embedded = 0;
  const errors: string[] = [];
  for (const d of docs) {
    if (!d.content) continue;
    const vec = await embed(`${d.title}. ${d.content}`, OPENROUTER_API_KEY);
    if (!vec) { errors.push(d.source_id); continue; }
    const { error } = await supabase.from("knowledge_embeddings").upsert(
      {
        source_type: d.source_type,
        source_id: d.source_id,
        title: d.title.slice(0, 500),
        content: d.content.slice(0, 4000),
        embedding: `[${vec.join(",")}]`,
        metadata: d.metadata,
      },
      { onConflict: "source_id" },
    );
    if (error) errors.push(`${d.source_id}: ${error.message}`);
    else embedded++;
  }

  console.log(`[embed-knowledge] candidates=${docs.length} embedded=${embedded} errors=${errors.length}`);
  return json({ ok: errors.length === 0, candidates: docs.length, embedded, errors: errors.slice(0, 20) });
});
