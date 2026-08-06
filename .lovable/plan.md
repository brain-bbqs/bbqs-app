# Ingest the workshop tool & device registry

Turn the uploaded `tool_device_registry.json` (174 entries) into live, queryable records behind the Devices and Resources pages, mapped onto the existing BBQS 3-layer model (resource hub -> typed table -> child detail tables).

## What is in the file

| Kind | Count | Meaning |
| --- | --- | --- |
| `category_label` | 92 | Generic modality names from the source spreadsheet ("Scalp EEG", "Eye tracking") |
| `software` | 35 | Real analysis/acquisition tools (DeepLabCut, SLEAP, MNE, NWB, PsychoPy) |
| `device` / `clinical_instrument` / `hybrid` | 35 | Hardware and clinical instruments (Neuropixels, EmotiBit, Tobii, ADOS, PPVT) |
| `custom` | 11 | Bespoke project code with no public docs |

Plus a 275-key `alias_index` mapping messy spreadsheet spellings to canonical `tool_id`s, and per-entry `prerequisites`, `installation`, `troubleshooting` (each item carrying a `source_url`), `maintainer`, `docs`, and a `verification` block.

Current state: `device_categories`, `device_models`, `device_manufacturers` and all four `device_category_*` tables are **empty**; `software_tools` has 18 rows. The Devices page derives its 32-category taxonomy client-side from a hardcoded array. This ingest fills those tables for real.

## Mapping to the model

```text
registry entry
   |
   +-- kind = category_label  ->  device_categories (label, description, measures)
   |
   +-- kind = device|clinical_instrument|hybrid
   |        ->  resources (resource_type='tool') + device_models
   |            + device_manufacturers (from maintainer.name)
   |
   +-- kind = software|repository
   |        ->  resources (resource_type='software') + software_tools
   |
   +-- kind = custom  ->  resources only, flagged no_public_docs
   |
   +-- prerequisites   ->  device_category_parameters (os, python, gpu as rows)
   +-- troubleshooting ->  tool_troubleshooting + device_category_pitfalls
   +-- docs + maintainer -> device_category_references
   +-- alias_index     ->  tool_aliases (canonical name resolution)
```

Every row keeps its `verification.status` and `verification.fields_verified`, so the UI can distinguish "confirmed against a fetched source" from "null = unresearched", exactly as the file's own description asks.

## Schema changes

1. **`tool_registry_entries`** - one row per registry entry: `tool_id` (unique), `display_name`, `kind`, `function`, `maintainer` (jsonb), `docs` (jsonb), `prerequisites` (jsonb), `installation` (jsonb), `license`, `verification_status`, `fields_verified` (text[]), `resource_id` FK, `raw` (jsonb passthrough), timestamps.
2. **`tool_aliases`** - `alias` (unique, normalized lowercase) -> `tool_id`. Backs fuzzy lookup from grant spreadsheets and from search.
3. **`tool_troubleshooting`** - `tool_id`, `question`, `answer`, `source_url`.
4. Add a nullable `tool_id` column to `device_models` and `software_tools` so existing rows reconcile against the registry.
5. Grants, RLS (public read, admin/curator write), and `updated_at` triggers on all new tables, following the existing device-table pattern.

## Ingest pipeline

New edge function `tool-registry-ingest`:

- Reads the registry JSON committed to `public/tool_device_registry.json` (single source of truth, re-runnable and diffable).
- Upserts on `tool_id`, so re-running is idempotent and never duplicates.
- Creates a `resources` row per non-category entry and links it, so tools join the same graph as grants, publications, and investigators.
- Maps category labels onto the existing 32-key BBQS taxonomy via the alias index, and reports any label that fails to match instead of silently dropping it.
- Optionally generates embeddings into `knowledge_embeddings` so the registry becomes RAG-visible to the assistants (same pattern as `device-knowledge-seed`).

Admin trigger: an "Ingest tool registry" button in Admin Console, with a dry-run mode that reports counts (created / updated / unmatched) before writing anything.

## UI changes

- **Devices page**: categories driven by `device_categories` rows instead of the hardcoded array; each device links to a detail view showing prerequisites, install methods, and troubleshooting Q&A with source links.
- **Resources page**: software entries become first-class tools with maintainer, docs, and license.
- **Verification chips**: `documented` / `identified` / `no_public_docs` / `not_a_product` badges so nobody mistakes an unresearched null for a real empty value.

## Sequencing

1. Migration for the new tables and columns.
2. Commit the registry JSON to `public/`.
3. Build and run `tool-registry-ingest` in dry-run, review counts.
4. Run for real, verify row counts against the file's 174 entries.
5. Wire the Devices and Resources UI to the populated tables.
6. Add the admin ingest button and the embeddings pass.

## Open question

The file says to join to `grant_project_info_enriched.csv` via `tool_device_refs_json[].tool_id`. That CSV was not uploaded. Without it, tools cannot be linked to specific BBQS grants - everything else works regardless. Send that CSV and step 7 becomes a `grant_tools` join table wiring each device to the projects that use it.
