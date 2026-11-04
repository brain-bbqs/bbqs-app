import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders, requireCuratorOrService } from "../_shared/auth.ts";

// ───────────────────────── Config ─────────────────────────
const MAX_DEPTH = 2;
const SIMILAR_PER_NODE = 5;
const PUBS_PER_PROJECT = 8;
const PER_SEED_PUB_CAP = 60;
const REPORTER = "https://api.reporter.nih.gov/v2";
const FIRECRAWL = "https://api.firecrawl.dev/v2/scrape";

// ─────────────────────── NIH RePORTER ────────────────────
async function reporterProject(grantNumber: string) {
  const res = await fetch(`${REPORTER}/projects/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: { project_nums: [grantNumber] },
      limit: 1,
      offset: 0,
    }),
  });
  const data = await res.json();
  return data?.results?.[0] ?? null;
}

async function reporterSimilar(coreProjectNum: string) {
  // RePORTER doesn't expose a clean similar-projects API; emulate by terms from
  // the seed's title+abstract using project search. Best-effort.
  const res = await fetch(`${REPORTER}/projects/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: { advanced_text_search: { operator: "and", search_field: "all", search_text: coreProjectNum } },
      limit: SIMILAR_PER_NODE + 1,
      offset: 0,
    }),
  });
  const data = await res.json();
  return (data?.results ?? []).filter((p: any) => p?.project_num !== coreProjectNum).slice(0, SIMILAR_PER_NODE);
}

async function reporterPubs(coreProjectNum: string) {
  const res = await fetch(`${REPORTER}/publications/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: { core_project_nums: [coreProjectNum] },
      limit: PUBS_PER_PROJECT,
      offset: 0,
    }),
  });
  const data = await res.json();
  return data?.results ?? [];
}

// ───────────────────────── Scrape ─────────────────────────
async function pmidToFullTextUrl(pmid: string): Promise<string> {
  // Try PMC first via NCBI elink
  try {
    const r = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pmc&id=${pmid}&retmode=json`,
    );
    const j = await r.json();
    const pmc = j?.linksets?.[0]?.linksetdbs?.[0]?.links?.[0];
    if (pmc) return `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmc}/`;
  } catch (_) {}
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

async function scrapeMarkdown(url: string): Promise<string | null> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) throw new Error("FIRECRAWL_API_KEY missing");
  const res = await fetch(FIRECRAWL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  if (!res.ok) {
    console.error("Firecrawl", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  return data?.data?.markdown ?? data?.markdown ?? null;
}

function extractMethodsSection(md: string): string | null {
  if (!md) return null;
  const lines = md.split("\n");
  const headingRe = /^(#{1,6})\s+(.+)$/;
  const methodsRe = /^(materials?\s+and\s+)?methods?\b|^experimental\s+procedures?\b|^data\s+acquisition\b/i;
  let start = -1, startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m && methodsRe.test(m[2].trim())) {
      start = i;
      startLevel = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m && m[1].length <= startLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").slice(0, 12000);
}

// ───────────────────────── LLM extract ────────────────────
async function extractStructured(methods: string, pubTitle: string) {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  const sys = `You extract experimental hardware and methods from biomedical paper Methods sections.
Return ONLY JSON matching the schema. Use empty arrays/objects when unknown. Quote verbatim from the text.`;
  const user = `Publication: ${pubTitle}\n\nMETHODS SECTION:\n${methods}\n\nReturn JSON with keys:
device_hardware (array of strings — devices, amplifiers, caps, with vendor/model),
stimulation_params (object — waveform, intensity, ISI, targets, frequency),
recording_params (object — sampling_rate_hz, channels, montage, filters),
analysis_metrics (array of strings — e.g. PCI, ADR),
setting (one of: ICU, outpatient, clinical_trial, independent_hospital, naturalistic, animal, unknown),
irb_or_population (short string),
quote (1-2 sentence verbatim Methods snippet capturing the key hardware/protocol),
confidence (0-1).`;
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    console.error("AI gateway", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  try {
    return JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
  } catch {
    return null;
  }
}

// ───────────────────────── Main ─────────────────────────
Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  // Every run spends LLM calls; sign-in alone is open to whole institutions.
  const denied = await requireCuratorOrService(req, cors);
  if (denied) return denied;

  try {
    const { seedGrantNumber } = await req.json();
    if (!seedGrantNumber || typeof seedGrantNumber !== "string") {
      return new Response(JSON.stringify({ error: "seedGrantNumber required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const visited = new Set<string>();
    const seenPmids = new Set<string>();
    const inserted: string[] = [];
    let pubBudget = PER_SEED_PUB_CAP;

    // Pre-seed seen PMIDs from existing rows
    const { data: existing } = await supabase
      .from("grant_methods_evidence")
      .select("pmid")
      .eq("seed_grant_number", seedGrantNumber);
    for (const r of existing ?? []) if (r.pmid) seenPmids.add(r.pmid);

    async function processProject(project: any, depth: number, matchScore: number | null) {
      if (pubBudget <= 0) return;
      const projectNum: string = project.project_num ?? project.core_project_num;
      if (!projectNum || visited.has(projectNum)) return;
      visited.add(projectNum);

      const coreNum: string = project.core_project_num ?? projectNum;
      const pubs = await reporterPubs(coreNum);
      let lowConfStreak = 0;

      for (const pub of pubs) {
        if (pubBudget <= 0) break;
        const pmid = String(pub.pmid ?? "");
        if (!pmid || seenPmids.has(pmid)) continue;
        seenPmids.add(pmid);
        pubBudget--;

        const url = await pmidToFullTextUrl(pmid);
        const md = await scrapeMarkdown(url);
        if (!md) continue;
        const methods = extractMethodsSection(md);
        if (!methods || methods.length < 300) continue;

        const extract = await extractStructured(methods, pub.publication_title ?? "");
        if (!extract) continue;
        const confidence = Number(extract.confidence ?? 0);
        if (confidence < 0.3) {
          lowConfStreak++;
          if (lowConfStreak >= 3) break;
        } else {
          lowConfStreak = 0;
        }

        const { data: ins, error } = await supabase
          .from("grant_methods_evidence")
          .upsert({
            seed_grant_number: seedGrantNumber,
            source_grant_number: projectNum,
            source_grant_title: project.project_title ?? null,
            source_org: project.organization?.org_name ?? null,
            source_org_type: project.organization?.org_type ?? null,
            depth,
            match_score: matchScore,
            pmid,
            publication_title: pub.publication_title ?? null,
            publication_year: pub.publication_year ?? null,
            source_url: url,
            methods_snippet: methods.slice(0, 8000),
            device_hardware: extract.device_hardware ?? [],
            stimulation_params: extract.stimulation_params ?? {},
            recording_params: extract.recording_params ?? {},
            analysis_metrics: extract.analysis_metrics ?? [],
            setting: extract.setting ?? null,
            irb_or_population: extract.irb_or_population ?? null,
            quote: extract.quote ?? null,
            confidence,
            extracted_at: new Date().toISOString(),
          }, { onConflict: "seed_grant_number,source_grant_number,pmid" })
          .select("id")
          .single();
        if (!error && ins) inserted.push(ins.id);
        else if (error) console.error("upsert", error);
      }
    }

    // Depth 0
    const seed = await reporterProject(seedGrantNumber);
    if (!seed) {
      return new Response(JSON.stringify({ error: "seed not found in NIH RePORTER" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    await processProject(seed, 0, null);

    // Depth 1
    const d1 = await reporterSimilar(seed.core_project_num ?? seedGrantNumber);
    for (const p of d1) {
      if (pubBudget <= 0) break;
      await processProject(p, 1, null);
    }

    // Depth 2 — similar of the first 2 d1 projects
    if (MAX_DEPTH >= 2) {
      for (const parent of d1.slice(0, 2)) {
        if (pubBudget <= 0) break;
        const d2 = await reporterSimilar(parent.core_project_num ?? parent.project_num);
        for (const p of d2) {
          if (pubBudget <= 0) break;
          await processProject(p, 2, null);
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      seed: seedGrantNumber,
      projects_visited: visited.size,
      publications_extracted: inserted.length,
      remaining_pub_budget: pubBudget,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("harvest-grant-methods", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});