// Device knowledge seed pipeline (plan: Device Knowledge Enrichment).
//
// Three idempotent passes:
//   1) curated JSON seeds committed under ./seeds/<category_key>.json
//   2) fold existing grant_methods_evidence into category_parameters
//   3) enqueue embeddings for the new rows so RAG picks them up
//
// Admin-only: requires the caller to be a signed-in curator/admin OR to
// present the CI_AUTH_SECRET as a bearer token (parity with harvester-tick).

import { createClient } from "npm:@supabase/supabase-js@2";

import heart_rate_sensors from "./seeds/heart_rate_sensors.json" with { type: "json" };
import eeg from "./seeds/eeg.json" with { type: "json" };
import neuropixels from "./seeds/neuropixels.json" with { type: "json" };
import video_cameras from "./seeds/video_cameras.json" with { type: "json" };
import ultrasonic_microphones from "./seeds/ultrasonic_microphones.json" with { type: "json" };
import accelerometer from "./seeds/accelerometer.json" with { type: "json" };
import ieeg from "./seeds/ieeg.json" with { type: "json" };
import neuroimaging_fmri from "./seeds/neuroimaging_fmri.json" with { type: "json" };
import opm from "./seeds/opm.json" with { type: "json" };
import tracking_software from "./seeds/tracking_software.json" with { type: "json" };

// Must match BBQS_TAXONOMY keys in src/pages/Devices.tsx. If a key drifts, seed
// fails loudly instead of silently orphaning rows.
const KNOWN_CATEGORY_KEYS = new Set([
  "video_cameras","neuropixels","thermal_cameras","ultrasonic_microphones",
  "rna_sequencing","heart_rate_sensors","eye_tracker","infrared_cameras",
  "wireless_neural","imu","rfid","respiration_sensors","accelerometer",
  "eeg","eda","plethysmography","intranasal_thermistor","emg","gps",
  "neuroimaging_fmri","flow_sensors","tracking_software","ieeg",
  "motion_tracking","cortisol_wearable","epinephrine_wearable","opm",
  "smartphone_camera","skin_temperature","vr","lidar","mmwave","other",
]);

type Seed = {
  category: {
    label: string;
    description?: string;
    measures?: string[];
    typical_use_cases?: string[];
    schema_org_type?: string;
  };
  parameters?: Array<Record<string, unknown>>;
  ml_specs?: Array<Record<string, unknown>>;
  pitfalls?: Array<Record<string, unknown>>;
  references?: Array<Record<string, unknown>>;
};

const SEEDS: Record<string, Seed> = {
  heart_rate_sensors, eeg, neuropixels, video_cameras, ultrasonic_microphones,
  accelerometer, ieeg, neuroimaging_fmri, opm, tracking_software,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Fold grant_methods_evidence.recording_params/stimulation_params/analysis_metrics
// into device_category_parameters. `device_class` on evidence is a text[]; we map
// each value with the same alias rules the UI uses.
function classToCategory(cls: string): string | null {
  const s = cls.toLowerCase();
  const table: Array<[string, string[]]> = [
    ["video_cameras", ["video_tracking","video","camera"]],
    ["neuropixels", ["neuropixel","silicon probe","imec"]],
    ["ultrasonic_microphones", ["ultrasonic","usv","audio_recording","microphone"]],
    ["heart_rate_sensors", ["heart rate","ecg","hrv"]],
    ["eeg", ["eeg"]],
    ["ieeg", ["ieeg","ecog","seeg"]],
    ["accelerometer", ["accelerometer","actigraph","wearable_actigraphy"]],
    ["wireless_neural", ["ephys_headstage","headstage","telemetry"]],
    ["tracking_software", ["deeplabcut","sleap","pose estimation"]],
    ["neuroimaging_fmri", ["fmri","mri"]],
    ["opm", ["opm","magnetometer"]],
  ];
  for (const [k, aliases] of table) if (aliases.some(a => s.includes(a))) return k;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const ci = Deno.env.get("CI_AUTH_SECRET");
    const auth = req.headers.get("authorization") ?? "";

    // Authorize: either curator/admin (via anon JWT) OR CI secret
    let authorized = false;
    if (ci && auth === `Bearer ${ci}`) authorized = true;
    if (!authorized && auth.startsWith("Bearer ")) {
      const jwt = auth.slice(7);
      const u = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
      const { data: userData } = await u.auth.getUser();
      if (userData.user) {
        const admin = createClient(url, serviceKey);
        const { data: ok } = await admin.rpc("is_curator_or_admin", { _user_id: userData.user.id });
        authorized = !!ok;
      }
    }
    if (!authorized) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });

    const sb = createClient(url, serviceKey);
    const stats: Record<string, number> = {
      categories: 0, parameters: 0, ml_specs: 0, pitfalls: 0, references: 0,
      folded_from_evidence: 0, embeddings_enqueued: 0,
    };

    // Guard: keys must match
    for (const key of Object.keys(SEEDS)) {
      if (!KNOWN_CATEGORY_KEYS.has(key)) {
        return new Response(JSON.stringify({ error: `Unknown category key: ${key}` }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      }
    }

    // Pass 1: curated JSON
    for (const [key, seed] of Object.entries(SEEDS)) {
      const catRow = {
        key,
        label: seed.category.label,
        description: seed.category.description ?? null,
        measures: seed.category.measures ?? [],
        typical_use_cases: seed.category.typical_use_cases ?? [],
        schema_org_type: seed.category.schema_org_type ?? null,
      };
      const { error: catErr } = await sb.from("device_categories").upsert(catRow, { onConflict: "key" });
      if (catErr) throw catErr;
      stats.categories++;

      if (seed.parameters?.length) {
        const rows = seed.parameters.map(p => ({ category_key: key, ...p }));
        const { error } = await sb.from("device_category_parameters").upsert(rows, { onConflict: "category_key,name" });
        if (error) throw error;
        stats.parameters += rows.length;
      }
      if (seed.ml_specs?.length) {
        const rows = seed.ml_specs.map(m => ({ category_key: key, ...m }));
        const { error } = await sb.from("device_category_ml_specs").upsert(rows, { onConflict: "category_key,task,input_signal" });
        if (error) throw error;
        stats.ml_specs += rows.length;
      }
      if (seed.pitfalls?.length) {
        const rows = seed.pitfalls.map(p => ({ category_key: key, ...p }));
        const { error } = await sb.from("device_category_pitfalls").upsert(rows, { onConflict: "category_key,issue" });
        if (error) throw error;
        stats.pitfalls += rows.length;
      }
      if (seed.references?.length) {
        const rows = seed.references.map(r => ({ category_key: key, ...r }));
        const { error } = await sb.from("device_category_references").upsert(rows, { onConflict: "category_key,kind,title" });
        if (error) throw error;
        stats.references += rows.length;
      }
    }

    // Pass 2: fold grant_methods_evidence params into category_parameters
    const { data: ev } = await sb
      .from("grant_methods_evidence")
      .select("device_class, recording_params, stimulation_params, analysis_metrics")
      .limit(2000);
    if (ev) {
      const seen = new Set<string>();
      const toInsert: Array<{ category_key: string; name: string; notes: string | null }> = [];
      for (const row of ev) {
        const classes: string[] = Array.isArray((row as any).device_class) ? (row as any).device_class : [];
        const categories = [...new Set(classes.map(classToCategory).filter(Boolean) as string[])];
        const blobs = [(row as any).recording_params, (row as any).stimulation_params, (row as any).analysis_metrics];
        for (const cat of categories) {
          for (const blob of blobs) {
            if (!blob || typeof blob !== "object") continue;
            for (const [name, val] of Object.entries(blob as Record<string, unknown>)) {
              const dedup = `${cat}::${name}`;
              if (seen.has(dedup)) continue;
              seen.add(dedup);
              toInsert.push({ category_key: cat, name, notes: typeof val === "string" ? val.slice(0, 400) : JSON.stringify(val).slice(0, 400) });
            }
          }
        }
      }
      if (toInsert.length) {
        // Insert with ignoreDuplicates so curated rows win on (category_key, name).
        const { error } = await sb.from("device_category_parameters").upsert(toInsert, { onConflict: "category_key,name", ignoreDuplicates: true });
        if (!error) stats.folded_from_evidence = toInsert.length;
      }
    }

    // Pass 3: embed the seeded rows directly into knowledge_embeddings using the same
    // OpenRouter model as embed-knowledge (openai/text-embedding-3-small, 1536-dim).
    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
    const embedRows: Array<{ source_type: string; source_id: string; title: string; content: string; metadata: Record<string, unknown> }> = [];
    for (const [key, seed] of Object.entries(SEEDS)) {
      embedRows.push({
        source_type: "device_category",
        source_id: key,
        title: `Device category: ${seed.category.label}`,
        content: `${seed.category.label}. ${seed.category.description ?? ""}\nMeasures: ${(seed.category.measures ?? []).join(", ")}\nUse cases: ${(seed.category.typical_use_cases ?? []).join(", ")}`.trim(),
        metadata: { key },
      });
      for (const p of seed.parameters ?? []) {
        const anyP = p as any;
        embedRows.push({
          source_type: "device_parameter",
          source_id: `${key}:${anyP.name}`,
          title: `${seed.category.label} parameter: ${anyP.name}`,
          content: [`${anyP.name}${anyP.symbol ? ` (${anyP.symbol})` : ""} — ${anyP.unit ?? ""} — typical ${anyP.typical_range ?? "n/a"}`, anyP.window_spec ? `Window: ${anyP.window_spec}` : "", anyP.standard_ref ? `Standard: ${anyP.standard_ref}` : "", anyP.notes ?? ""].filter(Boolean).join("\n"),
          metadata: { category_key: key, name: anyP.name },
        });
      }
      for (const m of seed.ml_specs ?? []) {
        const anyM = m as any;
        embedRows.push({
          source_type: "device_ml_spec",
          source_id: `${key}:${anyM.task}:${anyM.input_signal ?? ""}`,
          title: `${seed.category.label} ML: ${anyM.task}`,
          content: [`Task: ${anyM.task}`, `Input: ${anyM.input_signal ?? ""}`, anyM.sampling_rate_hz ? `Sampling: ${anyM.sampling_rate_hz} Hz` : "", `Preprocessing: ${(anyM.preprocessing ?? []).join(", ")}`, `Features: ${(anyM.feature_set ?? []).join(", ")}`, `Models: ${(anyM.common_models ?? []).join(", ")}`, `Labels: ${anyM.label_source ?? ""}`, `Datasets: ${(anyM.dataset_examples ?? []).join(", ")}`, anyM.notes ?? ""].filter(Boolean).join("\n"),
          metadata: { category_key: key, task: anyM.task },
        });
      }
      for (const r of seed.references ?? []) {
        const anyR = r as any;
        embedRows.push({
          source_type: "device_reference",
          source_id: `${key}:${anyR.title}`,
          title: `${seed.category.label} ref: ${anyR.title}`,
          content: `${anyR.title} — ${anyR.authority ?? ""} — ${anyR.year ?? ""} — ${anyR.doi ?? anyR.url ?? ""}`,
          metadata: { category_key: key, kind: anyR.kind, doi: anyR.doi, url: anyR.url },
        });
      }
    }
    if (openrouterKey) {
      for (const row of embedRows) {
        const er = await fetch("https://openrouter.ai/api/v1/embeddings", {
          method: "POST",
          headers: { Authorization: `Bearer ${openrouterKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "openai/text-embedding-3-small", input: row.content.slice(0, 8000) }),
        }).catch(() => null);
        if (!er || !er.ok) continue;
        const data = await er.json().catch(() => null);
        const vec = data?.data?.[0]?.embedding;
        if (!Array.isArray(vec)) continue;
        const { error } = await sb.from("knowledge_embeddings").upsert({
          source_type: row.source_type,
          source_id: row.source_id,
          title: row.title,
          content: row.content,
          metadata: row.metadata,
          embedding: vec,
        }, { onConflict: "source_type,source_id" });
        if (!error) stats.embeddings_enqueued++;
      }
    }

    return new Response(JSON.stringify({ ok: true, stats }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});