import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders, requireCuratorOrService } from "../_shared/auth.ts";

// ─────────────────────── External APIs ───────────────────────
const REPORTER = "https://api.reporter.nih.gov/v2";
const FIRECRAWL = "https://api.firecrawl.dev/v2/scrape";
const ICITE = "https://icite.od.nih.gov/api/pubs";
const AI = "https://ai.gateway.lovable.dev/v1";

type NodeRef = {
  type: string;
  id: string;          // canonical id (grant number, pmid, uuid)
  label?: string;
  text?: string;       // for embedding
  payload?: any;       // full data passthrough for extractor
};
type PathStep = { node: NodeRef; relation_in: string | null; hop: number; score: number };
type Path = PathStep[];

// ─────────────────────── Embeddings ───────────────────────
async function embed(text: string, key: string): Promise<number[] | null> {
  if (!text) return null;
  const res = await fetch(`${AI}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "google/gemini-embedding-001", input: text.slice(0, 8000) }),
  });
  if (!res.ok) { console.error("embed", res.status, await res.text()); return null; }
  const j = await res.json();
  return j?.data?.[0]?.embedding ?? null;
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// ─────────────────────── Neighbor fetchers ───────────────────────
async function reporterProject(grantNumber: string) {
  const res = await fetch(`${REPORTER}/projects/search`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ criteria: { project_nums: [grantNumber] }, limit: 1, offset: 0 }),
  });
  return (await res.json())?.results?.[0] ?? null;
}
async function reporterSimilar(coreProjectNum: string, limit: number) {
  const res = await fetch(`${REPORTER}/projects/search`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: { advanced_text_search: { operator: "and", search_field: "all", search_text: coreProjectNum } },
      limit: limit + 1, offset: 0,
    }),
  });
  return ((await res.json())?.results ?? []).filter((p: any) => p?.project_num !== coreProjectNum).slice(0, limit);
}
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "using", "used", "study", "studies",
  "brain", "behavior", "behaviour", "neural", "development", "project", "research", "effects", "based",
  "will", "can", "our", "their", "between", "across", "through", "during", "model", "models",
]);
function searchTermsFromProject(project: any): string {
  const text = `${project?.project_title ?? ""} ${project?.abstract_text ?? ""}`.toLowerCase();
  const words = text.match(/[a-z][a-z-]{3,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const raw of words) {
    const w = raw.replace(/^-|-$/g, "");
    if (STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const domainBoost = [
    "mouse", "mice", "rat", "animal", "animals", "adversity", "resilience", "trauma", "stress",
    "ethological", "ethologically", "tracking", "video", "home", "cage", "social", "open", "field",
    "wearable", "sensor", "device", "recording", "imaging", "optogenetic", "photometry", "miniscope",
  ].filter((t) => text.includes(t));
  const ranked = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .filter((w) => !domainBoost.includes(w));
  return [...domainBoost, ...ranked].slice(0, 10).join(" ");
}
async function reporterRelatedProjects(project: any, limit: number) {
  const query = searchTermsFromProject(project);
  if (!query) return [];
  const res = await fetch(`${REPORTER}/projects/search`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: { advanced_text_search: { operator: "or", search_field: "all", search_text: query } },
      limit: limit + 5, offset: 0,
    }),
  });
  const seedIds = new Set([project?.project_num, project?.core_project_num].filter(Boolean));
  return ((await res.json())?.results ?? [])
    .filter((p: any) => !seedIds.has(p?.project_num) && !seedIds.has(p?.core_project_num))
    .slice(0, limit);
}
async function reporterPubs(coreProjectNum: string, limit: number) {
  const res = await fetch(`${REPORTER}/publications/search`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ criteria: { core_project_nums: [coreProjectNum] }, limit, offset: 0 }),
  });
  return (await res.json())?.results ?? [];
}
async function icitePubs(pmids: string[]) {
  if (!pmids.length) return [];
  const url = `${ICITE}?pmids=${pmids.join(",")}`;
  const r = await fetch(url);
  return (await r.json())?.data ?? [];
}
function r61pair(grantNumber: string): string | null {
  if (/R61/i.test(grantNumber)) return grantNumber.replace(/R61/i, "R34");
  if (/R34/i.test(grantNumber)) return grantNumber.replace(/R34/i, "R61");
  return null;
}

async function expandNeighbors(node: NodeRef, relation: string, settings: any, onCall?: (msg: string) => Promise<void>): Promise<NodeRef[]> {
  const M = settings.targets_per_relation ?? 20;
  switch (relation) {
    case "similar_to": {
      if (node.type !== "grant") return [];
      const core = node.payload?.core_project_num ?? node.id;
      await onCall?.(`RePORTER: related projects for ${core}`);
      const sims = node.payload ? await reporterRelatedProjects(node.payload, M) : await reporterSimilar(core, M);
      return sims.map((p: any) => ({
        type: "grant", id: p.project_num,
        label: p.project_title,
        text: `${p.project_title ?? ""} ${p.abstract_text ?? ""}`,
        payload: p,
      }));
    }
    case "produced": {
      if (node.type !== "grant") return [];
      const core = node.payload?.core_project_num ?? node.id;
      await onCall?.(`RePORTER: publications for ${core}`);
      const pubs = await reporterPubs(core, M);
      return pubs.map((p: any) => ({
        type: "publication", id: String(p.pmid ?? ""),
        label: p.publication_title,
        text: p.publication_title ?? "",
        payload: p,
      })).filter((n: NodeRef) => n.id);
    }
    case "cites":
    case "cited_by": {
      if (node.type !== "publication") return [];
      await onCall?.(`iCite: ${relation} PMID ${node.id}`);
      const data = await icitePubs([node.id]);
      const ids: number[] = data?.[0]?.[relation === "cites" ? "references" : "cited_by"] ?? [];
      return ids.slice(0, M).map((pmid) => ({
        type: "publication", id: String(pmid),
        text: `pmid ${pmid}`,
        payload: { pmid },
      }));
    }
    case "r61_pair": {
      if (node.type !== "grant") return [];
      const pair = r61pair(node.id);
      if (!pair) return [];
      await onCall?.(`RePORTER: r61_pair ${pair}`);
      const p = await reporterProject(pair);
      if (!p) return [];
      return [{
        type: "grant", id: p.project_num,
        label: p.project_title,
        text: `${p.project_title ?? ""} ${p.abstract_text ?? ""}`,
        payload: p,
      }];
    }
    // has_investigator / co_pi_on / funded_by_org / affiliated_with / describes / uses_hardware
    // — DB-backed; fetched lazily by caller when needed. Stubbed for v1.
    default: return [];
  }
}

// ─────────────────────── Planner ───────────────────────
async function planHops(seedText: string, vocab: any[], maxHops: number, key: string): Promise<string[][]> {
  const sys = `You are a knowledge-graph planner. Given a seed grant abstract, produce a hop-wise plan to discover hardware and methods evidence used across related projects, especially R61↔R34 companion pairs and clinical-trial deployments.
You may ONLY use relations from the provided vocabulary. Output JSON {"hops": [[relation,...], ...]} with at most ${maxHops} hops. Each hop is an array of 1-3 relations to try in parallel.`;
  const user = `SEED ABSTRACT:\n${seedText.slice(0, 4000)}\n\nVOCABULARY:\n${vocab.map(v => `- ${v.name} (${v.src_node_type}→${v.dst_node_type}): ${v.description ?? ""}`).join("\n")}`;
  const res = await fetch(`${AI}/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) { console.error("planner", res.status, await res.text()); return [["similar_to"], ["produced"]]; }
  const j = await res.json();
  try {
    const parsed = JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
    const hops = parsed.hops as string[][];
    if (Array.isArray(hops) && hops.length) return hops.slice(0, maxHops);
  } catch {}
  return [["similar_to"], ["produced"]];
}

// ─────────────────────── Extractor (reused) ───────────────────────
async function pmidToUrl(pmid: string): Promise<string> {
  try {
    const r = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pmc&id=${pmid}&retmode=json`);
    const j = await r.json();
    const pmc = j?.linksets?.[0]?.linksetdbs?.[0]?.links?.[0];
    if (pmc) return `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmc}/`;
  } catch {}
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

// PubMed Central full-text via NCBI E-utilities. Free, no Firecrawl needed.
// Returns a Methods-heavy plain-text blob when the paper is in PMC OA.
async function fetchPmcFullText(pmid: string): Promise<string | null> {
  try {
    const linkRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pmc&id=${pmid}&retmode=json`);
    const linkJson = await linkRes.json();
    const pmcId = linkJson?.linksets?.[0]?.linksetdbs?.[0]?.links?.[0];
    if (!pmcId) return null;
    const xmlRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcId}&rettype=xml`);
    if (!xmlRes.ok) return null;
    const xml = await xmlRes.text();
    if (!xml || xml.length < 500) return null;
    // Strip XML/HTML tags → text. Preserve paragraph breaks so extractMethods can find headings.
    const text = xml
      .replace(/<sec[^>]*>/gi, "\n\n## ")
      .replace(/<title[^>]*>/gi, "")
      .replace(/<\/title>/gi, "\n")
      .replace(/<p[^>]*>/gi, "\n\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x?[0-9a-f]+;/gi, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text.length > 500 ? text : null;
  } catch (e) {
    console.warn("[pmc] full-text fetch failed", pmid, String(e).slice(0, 200));
    return null;
  }
}

async function scrapeMd(url: string): Promise<string | null> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return null;
  const res = await fetch(FIRECRAWL, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.data?.markdown ?? data?.markdown ?? null;
}
function extractMethods(md: string): string | null {
  if (!md) return null;
  const lines = md.split("\n");
  const headingRe = /^(#{1,6})\s+(.+)$/;
  const methodsRe = /^(materials?\s+and\s+)?methods?\b|^experimental\s+procedures?\b|^data\s+acquisition\b/i;
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m && methodsRe.test(m[2].trim())) { start = i; level = m[1].length; break; }
  }
  // Fallback: no Methods heading (typical for PubMed abstract pages or non-PMC sources).
  // Use the whole document so the LLM still has something to extract from.
  if (start === -1) return md.slice(0, 12000);
  let end = lines.length;
  for (let i = start+1; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").slice(0, 12000);
}
async function extractStructured(methods: string, title: string, key: string, sourceKind = "publication") {
  const sys = `You extract EVERY piece of experimental hardware mentioned in a neuroscience methods section — including stimulus delivery gear (monitors, speakers, air puffers, LED drivers), acquisition gear (cameras, cameras' sensors, macroscopes, microscopes, headstages, DAQs), behavior gear (treadmills, lickometers, head posts, cranial windows), and clinical devices. Any parenthetical of the form "<product name>, <company>" (e.g. "ProLite E1980, Iiyama" or "pco.edge, PCO" or "Pressure System IIe, Toohey Company") is a device_model + manufacturer pair — you MUST emit BOTH. Return ONLY JSON. Do not invent products; only emit what the text states. Emit MULTIPLE devices per paper. If the source is an NIH grant abstract, extract planned/required devices from explicit text even when no paper has been published yet.`;
  const user = `Source type: ${sourceKind}\nTitle: ${title}\n\nTEXT:\n${methods}\n\nKeys:
- device_hardware[] (free text list of every specific device/instrument named — cameras, monitors, speakers, injectors, macroscopes, probes, treadmills, head posts, silicone tubes, etc.)
- device_class[] (short lowercase snake_case buckets — reuse when possible: ephys_headstage, silicon_probe, miniscope, fiber_photometry, two_photon_imaging, macroscope, sCMOS_camera, CCD_camera, LCD_monitor, magnetic_speaker, pressure_injector, air_puffer, optogenetics_led, iEEG_clinical, sEEG_clinical, DBS_clinical, EEG_scalp, MEG, fMRI, wearable_actigraphy, head_fixed_rig, freely_moving_rig, lickometer, treadmill, video_tracking, ultrasound_neuromod, TMS, tFUS. INVENT new snake_case classes when nothing fits. Emit one class per distinct device.)
- device_model[] (specific product/model strings verbatim, e.g. "Neuropixels 2.0", "Inscopix nVista 3", "ProLite E1980", "pco.edge", "Pressure System IIe". Include EVERY model named.)
- manufacturer[] (canonical company names, e.g. "IMEC", "Inscopix", "Iiyama", "PCO", "Toohey Company", "Tucker-Davis Technologies", "Medtronic". Include EVERY company named.)
- modality[] (ANY of: ephys, imaging, stim, behavior, clinical_recording, neuroimaging)
- manual_urls[] (URLs to user manuals / datasheets / spec sheets if cited)
- regulatory (one of: research_use_only, FDA_510k, FDA_PMA, CE_marked, unknown)
- species[] (ANY of: mouse, rat, nhp_macaque, nhp_marmoset, human_adult, human_pediatric, human_neonate, other)
- behavior_paradigm[] (e.g. open_field, head_fixed_treadmill, lick_task, social_interaction, sleep, clinical_outcome_scale, free_behavior, decision_task)
- subject_n (integer or null)
- study_arm (one of: animal_model, clinical_translational, computational, unknown)
- stimulation_params{}, recording_params{}, analysis_metrics[]
- setting (ICU|outpatient|clinical_trial|independent_hospital|naturalistic|animal|unknown)
- environment_tags[] (FREE-FORM short lowercase snake_case strings. Emit whatever fits. Common examples: operating_room, ICU, outpatient_clinic, home_wearable, home_cage, head_fixed_rig, freely_moving_arena, open_field, treadmill_rig, water_maze, virtual_reality, sleep_lab, field_recording, wildlife_collar, zoo_enclosure, mri_bore, ambulatory, computational_only. Invent new tags when the paper describes an environment not listed. Max 6 tags.)
- use_case (ONE short sentence describing what the devices were used to record/stimulate/measure in this study.)
- irb_or_population, quote, confidence(0-1)

EXAMPLE — for the passage: "Visual stimuli were presented via LCD monitors (ProLite E1980, Iiyama)... Air puffs were delivered from a pressure injector (Pressure System IIe, Toohey Company)... via a magnetic speaker (Tucker-Davis Technologies)... imaged the two VSFP chromophores via two sCMOS cameras (pco.edge, PCO)..." you MUST emit:
  device_model: ["ProLite E1980","Pressure System IIe","pco.edge"],
  manufacturer: ["Iiyama","Toohey Company","Tucker-Davis Technologies","PCO"],
  device_class: ["LCD_monitor","pressure_injector","magnetic_speaker","sCMOS_camera","macroscope","treadmill"],
  device_hardware: ["LCD monitor ProLite E1980","pressure injector Pressure System IIe","magnetic speaker","sCMOS camera pco.edge","macroscope tandem lens","treadmill","CCD camera","thinned skull cranial window","head post"].`;
  const res = await fetch(`${AI}/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    console.error("[extract] AI gateway not ok", res.status, (await res.text().catch(()=>"" )).slice(0,400));
    return null;
  }
  try {
    const j = await res.json();
    const content = j?.choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(content);
  } catch (e) {
    console.error("[extract] JSON parse failed", String(e).slice(0,200));
    return null;
  }
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];
}
function uniqueStrings(...groups: string[][]): string[] {
  return Array.from(new Set(groups.flat().map((v) => v.trim()).filter(Boolean)));
}
function inferProjectDeviceHints(project: any) {
  const text = `${project?.project_title ?? ""}\n${project?.abstract_text ?? ""}`.toLowerCase();
  const deviceClass: string[] = [];
  const modality: string[] = [];
  const species: string[] = [];
  const behavior: string[] = [];
  const env: string[] = [];
  const hardware: string[] = [];
  if (/\bmice\b|\bmouse\b|murine/.test(text)) species.push("mouse");
  if (/\brats?\b/.test(text)) species.push("rat");
  if (/\bmonkey\b|macaque|marmoset|non[- ]?human primate/.test(text)) species.push(text.includes("marmoset") ? "nhp_marmoset" : "nhp_macaque");
  if (/\bhuman\b|children|adolescents|patients|participants/.test(text)) species.push("human_adult");
  if (/video|camera|tracking|pose|behavioral? tracking|etholog|behavior/.test(text)) {
    deviceClass.push("video_tracking");
    modality.push("behavior");
    hardware.push("animal behavior tracking system");
  }
  if (/home cage|home-cage/.test(text)) env.push("home_cage");
  if (/open field|arena|freely moving|free behavior|naturalistic|etholog/.test(text)) env.push("freely_moving_arena");
  if (/head[- ]?fixed/.test(text)) { deviceClass.push("head_fixed_rig"); env.push("head_fixed_rig"); }
  if (/treadmill/.test(text)) { deviceClass.push("treadmill"); env.push("treadmill_rig"); }
  if (/lick|water restriction|reward/.test(text)) deviceClass.push("lickometer");
  if (/miniscope|calcium imaging/.test(text)) { deviceClass.push("miniscope"); modality.push("imaging"); }
  if (/fiber photometry|photometry/.test(text)) { deviceClass.push("fiber_photometry"); modality.push("imaging"); }
  if (/two[- ]?photon|2-photon/.test(text)) { deviceClass.push("two_photon_imaging"); modality.push("imaging"); }
  if (/neuropixels|silicon probe|electrophysiology|ephys/.test(text)) { deviceClass.push("silicon_probe"); modality.push("ephys"); }
  if (/optogen/.test(text)) { deviceClass.push("optogenetics"); modality.push("stim"); }
  if (/fmri|mri/.test(text)) { deviceClass.push("fMRI"); modality.push("neuroimaging"); env.push("mri_bore"); }
  if (/wearable|actigraph|accelerometer/.test(text)) { deviceClass.push("wearable_actigraphy"); modality.push("behavior"); env.push("home_wearable"); }
  if (/social/.test(text)) behavior.push("social_interaction");
  if (/open field/.test(text)) behavior.push("open_field");
  if (/sleep/.test(text)) behavior.push("sleep");
  if (/decision/.test(text)) behavior.push("decision_task");
  if (/adversity|resilience|trauma|stress/.test(text)) behavior.push("developmental_adversity");
  return {
    device_hardware: uniqueStrings(hardware),
    device_class: uniqueStrings(deviceClass),
    modality: uniqueStrings(modality),
    species: uniqueStrings(species),
    behavior_paradigm: uniqueStrings(behavior),
    environment_tags: uniqueStrings(env.length ? env : deviceClass.length ? ["animal_behavior"] : []),
  };
}
function mergeExtract(llm: any, hints: any) {
  return {
    ...(llm ?? {}),
    device_hardware: uniqueStrings(asStrings(llm?.device_hardware), asStrings(hints.device_hardware)),
    device_class: uniqueStrings(asStrings(llm?.device_class), asStrings(hints.device_class)),
    device_model: uniqueStrings(asStrings(llm?.device_model)),
    manufacturer: uniqueStrings(asStrings(llm?.manufacturer)),
    modality: uniqueStrings(asStrings(llm?.modality), asStrings(hints.modality)),
    manual_urls: uniqueStrings(asStrings(llm?.manual_urls)),
    species: uniqueStrings(asStrings(llm?.species), asStrings(hints.species)),
    behavior_paradigm: uniqueStrings(asStrings(llm?.behavior_paradigm), asStrings(hints.behavior_paradigm)),
    environment_tags: uniqueStrings(asStrings(llm?.environment_tags), asStrings(hints.environment_tags)),
  };
}

// ─────────────────────── Main ───────────────────────
Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  // harvester-tick calls in with the service key; anyone else must be a curator, since every run
  // spends LLM and scraping calls and sign-in alone is open to whole institutions.
  const denied = await requireCuratorOrService(req, cors);
  if (denied) return denied;

  let requestBody: any = {};
  try { requestBody = await req.json(); } catch { requestBody = {}; }

  try {
    const { seedGrantNumber } = requestBody;
    if (!seedGrantNumber) return new Response(JSON.stringify({ error: "seedGrantNumber required" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const aiKey = Deno.env.get("LOVABLE_API_KEY")!;
    const startedAt = Date.now();
    const WALL_MS = 90_000;

    // Create a live run row so the UI can subscribe
    let runId = internalServiceCall && typeof requestBody?.runId === "string" ? requestBody.runId : undefined;
    if (runId) {
      await supabase.from("harvester_runs").update({
        phase: "scraping",
        current_target: null,
        last_message: "Loading seed",
        updated_at: new Date().toISOString(),
      }).eq("id", runId);
    } else {
      const { data: runRow } = await supabase.from("harvester_runs").insert({
        seed_grant: seedGrantNumber, phase: "scraping", last_message: "Loading seed",
      }).select("id").single();
      runId = runRow?.id as string | undefined;
    }
    const tick = async (patch: Record<string, any>) => {
      if (!runId) return;
      await supabase.from("harvester_runs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", runId);
    };
    let firecrawlCalls = 0, pubsFound = 0, evidenceRows = 0, errors = 0;
    let similarProjectsVisited = 0;
    const hopSimilarities: { hop: number; relation: string; scores: number[] }[] = [];
    const upsertProjectDeviceEvidence = async (project: any, depth: number, chainScore: number, pathId: string | null = null) => {
      const projectNum = project?.project_num ?? project?.core_project_num;
      const abstract = String(project?.abstract_text ?? "").trim();
      if (!projectNum || abstract.length < 120) return false;
      const title = String(project?.project_title ?? projectNum);
      const hints = inferProjectDeviceHints(project);
      const llm = await extractStructured(abstract.slice(0, 9000), title, aiKey, "NIH grant abstract");
      const extract = mergeExtract(llm, hints);
      const hasDeviceSignal = extract.device_class.length || extract.device_model.length || extract.manufacturer.length || extract.device_hardware.length;
      if (!hasDeviceSignal) return false;
      const useCase = typeof llm?.use_case === "string" && llm.use_case.trim()
        ? llm.use_case.slice(0, 500)
        : `Planned ${extract.device_class.map((d: string) => d.replace(/_/g, " ")).slice(0, 2).join(" and ")} for ${extract.species.join("/") || "study subjects"}.`;
      const syntheticPmid = `PROJECT:${projectNum}`;
      const { data: ev, error: evErr } = await supabase.from("grant_methods_evidence").upsert({
        seed_grant_number: seedGrantNumber,
        source_grant_number: projectNum,
        source_grant_title: title,
        source_org: project?.organization?.org_name ?? null,
        source_org_type: project?.organization?.org_type ?? null,
        depth,
        match_score: chainScore,
        pmid: syntheticPmid,
        publication_title: `${title} — NIH project abstract`,
        publication_year: Number(project?.fy) || null,
        source_url: `https://reporter.nih.gov/project-details/${encodeURIComponent(projectNum)}`,
        methods_snippet: abstract.slice(0, 8000),
        device_hardware: extract.device_hardware,
        device_class: extract.device_class,
        device_model: extract.device_model,
        manufacturer: extract.manufacturer,
        modality: extract.modality,
        manual_urls: extract.manual_urls,
        regulatory: typeof llm?.regulatory === "string" ? llm.regulatory : "unknown",
        species: extract.species,
        behavior_paradigm: extract.behavior_paradigm,
        subject_n: Number.isFinite(Number(llm?.subject_n)) ? Number(llm.subject_n) : null,
        study_arm: typeof llm?.study_arm === "string" ? llm.study_arm : (extract.species.includes("mouse") || extract.species.includes("rat") ? "animal_model" : "unknown"),
        stimulation_params: llm?.stimulation_params ?? {},
        recording_params: llm?.recording_params ?? {},
        analysis_metrics: Array.isArray(llm?.analysis_metrics) ? llm.analysis_metrics : [],
        setting: typeof llm?.setting === "string" ? llm.setting : (extract.species.includes("mouse") || extract.species.includes("rat") ? "animal" : "unknown"),
        irb_or_population: typeof llm?.irb_or_population === "string" ? llm.irb_or_population : null,
        quote: typeof llm?.quote === "string" ? llm.quote : abstract.slice(0, 500),
        confidence: Math.max(Number(llm?.confidence ?? 0.55), hints.device_class.length ? 0.65 : 0.4),
        environment_tags: extract.environment_tags,
        use_case: useCase,
        extracted_at: new Date().toISOString(),
        discovery_path_id: pathId,
      }, { onConflict: "seed_grant_number,source_grant_number,pmid" }).select("id").single();
      if (evErr) {
        errors++;
        console.error("[project] evidence upsert failed", { projectNum, err: evErr.message, code: (evErr as any).code, details: (evErr as any).details });
        return false;
      }
      evidenceRows++;
      await tick({ evidence_rows: evidenceRows, last_message: `Captured devices from NIH project ${projectNum}` });
      console.log("[project] evidence upserted", { projectNum, id: ev?.id, classes: extract.device_class });
      return true;
    };

    // Load settings + vocabulary
    const { data: settings } = await supabase.from("harvester_settings").select("*").eq("id", 1).single();
    const { data: vocab } = await supabase.from("harvester_relations").select("*").eq("enabled", true);
    const vocabNames = new Set((vocab ?? []).map((v: any) => v.name));
    const beam = settings?.beam_width ?? 3;
    const maxHops = settings?.max_hops ?? 5;
    const threshold = settings?.chain_score_threshold ?? 0.15;
    const pubCap = settings?.max_publications_per_seed ?? 120;

    // Seed
    const seed = await reporterProject(seedGrantNumber);
    if (!seed) {
      await tick({ phase: "error", last_message: "seed not in NIH RePORTER", finished_at: new Date().toISOString(), errors: 1 });
      return new Response(JSON.stringify({ error: "seed not in NIH RePORTER" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const seedText = `${seed.project_title ?? ""}\n${seed.abstract_text ?? ""}`;
    const seedEmbedding = await embed(seedText, aiKey);
    if (!seedEmbedding) {
      await tick({ phase: "error", last_message: "seed embedding failed", finished_at: new Date().toISOString(), errors: 1 });
      return new Response(JSON.stringify({ error: "seed embedding failed" }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }
    await upsertProjectDeviceEvidence(seed, 0, 1);

    // Plan
    await tick({ phase: "hopping", last_message: "Planning hops", current_hop: 0 });
    const hops = await planHops(seedText, vocab ?? [], maxHops, aiKey);
    const validatedHops: string[][] = [];
    for (const hop of hops) {
      const valid: string[] = [];
      for (const r of hop) {
        if (vocabNames.has(r)) valid.push(r);
        else {
          await supabase.from("proposed_relations").insert({
            relation_name: r, seed_grant_number: seedGrantNumber,
            planner_rationale: `Planner suggested at hop ${validatedHops.length}`,
          });
        }
      }
      if (valid.length) validatedHops.push(valid.slice(0, beam));
    }

    // GUARANTEE: seed grant's own publications are always crawled at hop 1.
    // Otherwise the planner often opens with ["similar_to"] and we never reach
    // any publication whose chain score survives the threshold. Prepending
    // "produced" as its own hop ensures every run has at least one paper to
    // extract from, so evidence rows actually land.
    if (vocabNames.has("produced")) {
      const first = validatedHops[0] ?? [];
      if (!first.includes("produced")) {
        validatedHops.unshift(["produced"]);
      }
    }

    // BFS frontier with chain-score pruning
    const seedNode: NodeRef = { type: "grant", id: seed.project_num, label: seed.project_title, text: seedText, payload: seed };
    let frontier: { node: NodeRef; path: Path; chainScore: number }[] = [
      { node: seedNode, path: [{ node: seedNode, relation_in: null, hop: 0, score: 1 }], chainScore: 1 },
    ];
    const visited = new Set<string>([`${seedNode.type}:${seedNode.id}`]);
    const seenPmids = new Set<string>();
    const { data: existing } = await supabase.from("grant_methods_evidence").select("pmid").eq("seed_grant_number", seedGrantNumber);
    (existing ?? []).forEach((r: any) => r.pmid && seenPmids.add(r.pmid));

    let pubsExtracted = 0;
    const insertedPathIds: string[] = [];

    for (let hopIdx = 0; hopIdx < validatedHops.length; hopIdx++) {
      if (Date.now() - startedAt > WALL_MS) break;
      const relations = validatedHops[hopIdx];
      await tick({ phase: "hopping", current_hop: hopIdx + 1, last_message: `Hop ${hopIdx + 1}: ${relations.join(", ")}` });
      const nextFrontier: typeof frontier = [];

      for (const f of frontier) {
        for (const rel of relations) {
          const neighbors = await expandNeighbors(f.node, rel, settings, async (msg) => {
            await tick({ phase: "hopping", current_target: msg, last_message: msg });
          });
          // Score by embedding similarity
          const scored: { n: NodeRef; s: number }[] = [];
          for (const n of neighbors) {
            const key = `${n.type}:${n.id}`;
            if (visited.has(key)) continue;
            const emb = await embed(`${rel}: ${n.label ?? ""} ${n.text ?? ""}`, aiKey);
            const s = emb ? Math.max(0, cosine(seedEmbedding, emb)) : 0.1;
            scored.push({ n, s });
          }
          scored.sort((a, b) => b.s - a.s);
          const kept = scored.slice(0, beam);
          if (kept.length) {
            hopSimilarities.push({
              hop: hopIdx + 1,
              relation: rel,
              scores: kept.map(k => Number(k.s.toFixed(3))),
            });
          }
          for (const { n, s } of kept) {
            const chain = f.chainScore * s;
            // Never prune the seed grant's own direct publications — we need
            // guaranteed evidence to land, and these are as on-topic as it gets.
            const isSeedProduced = f.node.type === "grant"
              && f.node.id === seedGrantNumber
              && rel === "produced";
            if (!isSeedProduced && chain < threshold) continue;
            visited.add(`${n.type}:${n.id}`);
            if (n.type === "grant" && n.id !== seedGrantNumber) similarProjectsVisited++;
            const newPath: Path = [...f.path, { node: n, relation_in: rel, hop: hopIdx + 1, score: s }];
            nextFrontier.push({ node: n, path: newPath, chainScore: chain });
            // Write traversal path immediately so KG Live populates (bunny hops here)
            // even before/independent of Firecrawl extraction success.
            await supabase.from("grant_methods_traversal_paths").insert({
              seed_grant_number: seedGrantNumber,
              path: newPath.map(s => ({
                node_type: s.node.type, node_id: s.node.id, label: s.node.label,
                relation_in: s.relation_in, hop: s.hop, score: s.score,
              })),
              chain_score: chain,
              planner_model: "google/gemini-3-flash-preview",
            });
            if (n.type === "grant") {
              await upsertProjectDeviceEvidence(n.payload, hopIdx + 1, chain);
            }
          }
        }
      }

      // Process any publication nodes reached this hop
      for (const f of nextFrontier) {
        if (Date.now() - startedAt > WALL_MS) break;
        if (pubsExtracted >= pubCap) break;
        if (f.node.type !== "publication") continue;
        const pmid = f.node.id;
        if (!pmid || seenPmids.has(pmid)) continue;
        seenPmids.add(pmid);
        pubsExtracted++;
        pubsFound++;
        await tick({ phase: "extracting", current_target: `PMID ${pmid}`, pubs_found: pubsFound, last_message: f.node.label ?? `PMID ${pmid}` });

        const url = await pmidToUrl(pmid);
        // Try PubMed Central full-text XML FIRST — free, complete Methods section,
        // and this is where manufacturer/model parentheticals actually live. Only
        // fall back to Firecrawl (which usually just gets the abstract page) if
        // the paper isn't in PMC OA.
        let md = await fetchPmcFullText(pmid);
        if (!md || md.length < 500) {
          md = await scrapeMd(url);
          firecrawlCalls++;
        } else {
          await tick({ current_target: `PMC full-text PMID ${pmid}`, last_message: `PMC full-text PMID ${pmid}` });
        }
        // Fallback chain: Firecrawl → publication title/abstract from RePORTER payload.
        if (!md || md.length < 200) {
          const fallback = [
            f.node.label,
            f.node.payload?.abstract,
            f.node.payload?.publication_title,
          ].filter(Boolean).join("\n\n");
          md = fallback || md;
        }
        if (!md) continue;
        const methods = extractMethods(md);
        // Allow short snippets — abstract-only pages are still extractable.
        if (!methods || methods.length < 120) {
          console.warn("[hop] methods too short", { pmid, mdLen: md.length, methodsLen: methods?.length ?? 0 });
          continue;
        }
        const extract = await extractStructured(methods, f.node.label ?? "", aiKey);
        if (!extract) {
          console.warn("[hop] extract returned null", { pmid });
          continue;
        }
        console.log("[hop] extracted", { pmid, devices: (extract.device_model ?? []).length, mfrs: (extract.manufacturer ?? []).length });

        // Insert traversal path first
        const { data: pathRow } = await supabase.from("grant_methods_traversal_paths").insert({
          seed_grant_number: seedGrantNumber,
          path: f.path.map(s => ({ node_type: s.node.type, node_id: s.node.id, label: s.node.label, relation_in: s.relation_in, hop: s.hop, score: s.score })),
          chain_score: f.chainScore,
          planner_model: "google/gemini-3-flash-preview",
        }).select("id").single();

        // Find source grant from path
        const sourceGrant = [...f.path].reverse().find(s => s.node.type === "grant")?.node;

        const { data: ev, error: evErr } = await supabase.from("grant_methods_evidence").upsert({
          seed_grant_number: seedGrantNumber,
          source_grant_number: sourceGrant?.id ?? seedGrantNumber,
          source_grant_title: sourceGrant?.label ?? null,
          source_org: sourceGrant?.payload?.organization?.org_name ?? null,
          source_org_type: sourceGrant?.payload?.organization?.org_type ?? null,
          depth: f.path.length - 1,
          match_score: f.chainScore,
          pmid, publication_title: f.node.label ?? null,
          publication_year: f.node.payload?.publication_year ?? null,
          source_url: url,
          methods_snippet: methods.slice(0, 8000),
          device_hardware: extract.device_hardware ?? [],
          device_class: Array.isArray(extract.device_class) ? extract.device_class : [],
          device_model: Array.isArray(extract.device_model) ? extract.device_model.map(String) : [],
          manufacturer: Array.isArray(extract.manufacturer) ? extract.manufacturer.map(String) : [],
          modality: Array.isArray(extract.modality) ? extract.modality.map(String) : [],
          manual_urls: Array.isArray(extract.manual_urls) ? extract.manual_urls.map(String) : [],
          regulatory: typeof extract.regulatory === "string" ? extract.regulatory : null,
          species: Array.isArray(extract.species) ? extract.species : [],
          behavior_paradigm: Array.isArray(extract.behavior_paradigm) ? extract.behavior_paradigm : [],
          subject_n: Number.isFinite(Number(extract.subject_n)) ? Number(extract.subject_n) : null,
          study_arm: typeof extract.study_arm === "string" ? extract.study_arm : null,
          stimulation_params: extract.stimulation_params ?? {},
          recording_params: extract.recording_params ?? {},
          analysis_metrics: extract.analysis_metrics ?? [],
          setting: extract.setting ?? null,
          irb_or_population: extract.irb_or_population ?? null,
          quote: extract.quote ?? null,
          confidence: Number(extract.confidence ?? 0),
          environment_tags: Array.isArray(extract.environment_tags) ? extract.environment_tags.map(String) : [],
          use_case: typeof extract.use_case === "string" ? extract.use_case.slice(0, 500) : null,
          extracted_at: new Date().toISOString(),
          discovery_path_id: pathRow?.id ?? null,
        }, { onConflict: "seed_grant_number,source_grant_number,pmid" }).select("id").single();
        if (evErr) console.error("[hop] evidence upsert failed", { pmid, err: evErr.message, code: (evErr as any).code, details: (evErr as any).details });
        else console.log("[hop] evidence upserted", { pmid, id: ev?.id });

        if (pathRow?.id && ev?.id) {
          await supabase.from("grant_methods_traversal_paths").update({ terminal_evidence_id: ev.id }).eq("id", pathRow.id);
          insertedPathIds.push(pathRow.id);
          evidenceRows++;
          await tick({ evidence_rows: evidenceRows, firecrawl_calls: firecrawlCalls });
        }

        // Upsert canonical manufacturers + models so they become first-class KG nodes
        try {
          const mfrs: string[] = Array.isArray(extract.manufacturer) ? extract.manufacturer.map((m: any) => String(m).trim()).filter(Boolean) : [];
          const models: string[] = Array.isArray(extract.device_model) ? extract.device_model.map((m: any) => String(m).trim()).filter(Boolean) : [];
          const classes: string[] = Array.isArray(extract.device_class) ? extract.device_class.map((m: any) => String(m).trim()).filter(Boolean) : [];
          const manualUrls: string[] = Array.isArray(extract.manual_urls) ? extract.manual_urls.map((m: any) => String(m).trim()).filter(Boolean) : [];
          const mfrIds: Record<string, string> = {};
          for (const name of mfrs) {
            const { data: row } = await supabase
              .from("device_manufacturers")
              .upsert({ name }, { onConflict: "name" })
              .select("id").single();
            if (row?.id) mfrIds[name] = row.id;
          }
          for (const model of models) {
            for (const cls of (classes.length ? classes : ["other"])) {
              const mfrName = mfrs[0];
              const payload: any = {
                manufacturer_id: mfrName ? mfrIds[mfrName] ?? null : null,
                device_class: cls,
                model_name: model,
                manual_urls: manualUrls,
                confidence: Number(extract.confidence ?? 0),
                last_verified_at: new Date().toISOString(),
              };
              await supabase.from("device_models").upsert(payload, { onConflict: "manufacturer_id,device_class,model_name" });
            }
          }
        } catch (e) {
          console.error("device canonicalization failed", e);
        }

        // Track novel keywords for curator review
        const kwRows: { term: string; kind: string }[] = [];
        for (const t of (extract.device_class ?? [])) kwRows.push({ term: String(t).toLowerCase(), kind: "device" });
        for (const t of (extract.device_model ?? [])) kwRows.push({ term: String(t).toLowerCase().slice(0, 80), kind: "device_model" });
        for (const t of (extract.manufacturer ?? [])) kwRows.push({ term: String(t).toLowerCase().slice(0, 80), kind: "manufacturer" });
        for (const t of (extract.behavior_paradigm ?? [])) kwRows.push({ term: String(t).toLowerCase(), kind: "behavior" });
        for (const t of (extract.species ?? [])) kwRows.push({ term: String(t).toLowerCase(), kind: "species" });
        for (const t of (extract.analysis_metrics ?? [])) kwRows.push({ term: String(t).toLowerCase().slice(0, 60), kind: "analysis" });
        for (const kw of kwRows) {
          if (!kw.term) continue;
          const { data: existing } = await supabase
            .from("harvester_keywords")
            .select("id,frequency")
            .eq("term", kw.term).eq("kind", kw.kind).maybeSingle();
          if (existing) {
            await supabase.from("harvester_keywords")
              .update({ frequency: (existing.frequency ?? 0) + 1, last_seen_at: new Date().toISOString() })
              .eq("id", existing.id);
          } else {
            await supabase.from("harvester_keywords").insert({ term: kw.term, kind: kw.kind, frequency: 1 });
          }
        }
      }

      // Beam-prune next frontier overall
      nextFrontier.sort((a, b) => b.chainScore - a.chainScore);
      frontier = nextFrontier.slice(0, beam * 5);
      if (!frontier.length) break;
    }

    await tick({
      phase: "done", finished_at: new Date().toISOString(),
      pubs_found: pubsFound, evidence_rows: evidenceRows, firecrawl_calls: firecrawlCalls, errors,
      last_message: `Done: ${evidenceRows} rows · ${similarProjectsVisited} similar projects · ${hopSimilarities.length} hops`,
      hops_taken: hopSimilarities.length,
      hop_similarities: hopSimilarities,
      similar_projects_visited: similarProjectsVisited,
      max_hops_configured: maxHops,
    });

    return new Response(JSON.stringify({
      ok: true, mode: "multihop", seed: seedGrantNumber,
      hops_planned: validatedHops, publications_extracted: pubsExtracted,
      paths_recorded: insertedPathIds.length, run_id: runId,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("multihop", e);
    return new Response(JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});