# Device Knowledge Enrichment — backend + seed plan

Goal: give the agent structured, cite-able facts for each of the 32 BBQS device categories so probes like "HRV parameters + sensors" score P1≥3 on the QA rubric (spec 009). Today the schema has `device_manufacturers`, `device_models`, and per-evidence JSON blobs on `grant_methods_evidence`, but nothing that captures *what a category measures*, *which parameters people report*, or *what ML pipelines consume it*. We add that layer.

## Scope

In:
- New backend tables for category-level knowledge (measurables, parameters, ML training specs, common pitfalls, canonical references).
- Model-level enrichment (firmware/sampling, output signals, SDKs).
- Seed pipeline that fills the tables from (a) curated JSON we own, (b) grant_methods_evidence already harvested, (c) targeted paper fetches per category.
- Agent retrieval: expose the new rows through `knowledge_embeddings` so the existing RAG path picks them up — no new tool wiring.

Out (later features):
- No changes to the QA probe runner (spec 009) or to `Devices.tsx` UI beyond a small "Details" drawer.
- No new auth surface; all writes go through admin/curator RLS we already have.

## Data model (new / changed)

```text
device_categories                  ← 32 canonical rows, one per BBQS_TAXONOMY key
  key, label, description, measures[], typical_use_cases[], schema_org_type

device_category_parameters         ← the "SDNN / RMSSD / LF-HF" layer
  category_key, name, symbol, unit, typical_range, window_spec,
  standard_ref (e.g. "Task Force 1996"), notes

device_category_ml_specs           ← "how you train / what you feed a model"
  category_key, task (classification|regression|segmentation|forecasting|…),
  input_signal, sampling_rate_hz, preprocessing[], feature_set[],
  common_models[], label_source, dataset_examples[], notes

device_category_pitfalls           ← replaces the in-code COMMON_ISSUES map
  category_key, issue, mitigation, severity

device_category_references         ← canonical papers / standards / manuals
  category_key, kind (paper|standard|manual|dataset),
  title, url, doi, year, authority

device_models (existing)  +columns:
  sampling_rate_hz, output_signals[], sdk_urls[], firmware_notes,
  regulatory_class, price_tier
```

All new tables: `resource_id uuid` FK to `resources` (so they participate in the KG), `organization_id` nullable, standard `created_at/updated_at`, GRANTs for `anon SELECT` + `authenticated`/`service_role` write, RLS: public read, admin/curator write via `is_curator_or_admin(auth.uid())`.

## Retrieval wiring

- Trigger on insert/update of each new table → enqueues an `embed-knowledge` job that writes to `knowledge_embeddings` with `source_type='device_category'|'device_parameter'|'device_ml_spec'|'device_pitfall'|'device_reference'` and a compact `title` + `content` (e.g. "HRV parameter SDNN — ms — 5-min window — Task Force 1996").
- The existing `search_knowledge_embeddings` RPC then surfaces these rows to `discovery-chat` / `metadata-chat` / `assistant-router` without further code changes.

## Seed pipeline (`supabase/functions/device-knowledge-seed`)

Three passes per category, idempotent (`onConflict: category_key,name`):

1. **Curated JSON** at `supabase/functions/device-knowledge-seed/seeds/<key>.json` — we own this; HRV, Neuropixels, EEG, video/pose, ultrasonic mics, wearable actigraphy, fMRI, iEEG, OPM ship in the first PR.
2. **Fold existing evidence** — for each `grant_methods_evidence` row, if `device_class` maps to a category, promote its `recording_params` / `stimulation_params` / `analysis_metrics` keys into `device_category_parameters` (dedup by (category, name)).
3. **Targeted paper fetch** — for gaps, call `paper-extract` on a short whitelist of canonical refs per category (e.g. Task Force 1996 for HRV) to pull parameter tables.

Admin surface: existing `/admin` console gets a "Device knowledge" panel listing coverage per category (params N, ml_specs N, refs N) with a "Reseed" button that calls the function.

## HRV worked example (acceptance for this feature)

After seeding, an anon `search_knowledge_embeddings("heart rate variability parameters sensors")` returns, in order:
- `device_category:heart_rate_sensors` — description + measures
- `device_parameter:SDNN`, `RMSSD`, `pNN50`, `LF/HF`, `HF power` — each with unit, window, standard_ref
- `device_ml_spec:hrv_stress_classification` — 1000 Hz ECG → RR intervals → 5-min windows → gradient-boosted/1D-CNN
- `device_reference:Task Force 1996`, `Shaffer & Ginsberg 2017`
- `device_model:Polar H10`, `Empatica E4`, `ActiGraph GT9X` with sampling_rate + output_signals

This is exactly what QA probe P1-A expects; passing means the pipeline works.

## Deliverables

1. One migration adding the 5 new tables + `device_models` columns + GRANTs + RLS + embedding triggers.
2. `supabase/functions/device-knowledge-seed/` with the 3-pass runner and 9 curated JSON seeds (the categories that carry the most-asked probes).
3. Small `/admin` panel + a "Details" drawer on `/devices` rows that renders the new fields.
4. One follow-up run of the QA itinerary (spec 009) to confirm P1-A/B/C scores move to ≥3.

## Non-goals / explicit constraints

- Do not modify `grant_methods_evidence`, harvester tables, or the agent tool list.
- Do not introduce a second embedding store — reuse `knowledge_embeddings`.
- Category keys must stay in sync with `BBQS_TAXONOMY` in `src/pages/Devices.tsx`; the seed function fails loudly if a key drifts.

Approve and I'll ship the migration first (single call), then the seed function + curated JSON, then the UI drawer.