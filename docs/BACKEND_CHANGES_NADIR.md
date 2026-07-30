# Backend / Table Changes — Summary for Nadir

Scope: schema added since the device-taxonomy work, grouped by feature. All tables live in
`public`, carry `created_at`/`updated_at`, have RLS enabled, and are readable by `anon`
unless noted. Writes are gated on `is_curator_or_admin(auth.uid())`.

---

## 1. Device Knowledge Enrichment

Gives the agent structured, cite-able facts for each of the 32 BBQS device categories.
Category keys stay in sync with `BBQS_TAXONOMY` in `src/pages/Devices.tsx`.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `device_categories` | 32 canonical rows, one per taxonomy key | `key`, `label`, `description`, `measures[]`, `typical_use_cases[]`, `schema_org_type`, `resource_id` |
| `device_category_parameters` | Reportable measures (SDNN, RMSSD, LF/HF…) | `category_key`, `name`, `symbol`, `unit`, `typical_range`, `window_spec`, `standard_ref` |
| `device_category_ml_specs` | How a model consumes the signal | `task`, `input_signal`, `sampling_rate_hz`, `preprocessing[]`, `feature_set[]`, `common_models[]`, `label_source`, `dataset_examples[]` |
| `device_category_pitfalls` | Replaces the old in-code issues map | `issue`, `mitigation`, `severity` |
| `device_category_references` | Canonical papers / standards / manuals | `kind`, `title`, `url`, `doi`, `year`, `authority` |

`device_models` gained: `sampling_rate_hz`, `output_signals[]`, `sdk_urls[]`,
`firmware_notes`, `regulatory_class`, `price_tier`.

**Retrieval:** rows are embedded into the existing `knowledge_embeddings` store with
`source_type` in `device_category | device_parameter | device_ml_spec | device_pitfall |
device_reference`, so `search_knowledge_embeddings()` surfaces them to the chat agents with
no new tool wiring. No second embedding store.

**Seeding:** `supabase/functions/device-knowledge-seed` — idempotent three-pass runner
(curated JSON seeds → fold existing `grant_methods_evidence` params → targeted paper fetch),
scheduled nightly at 04:17 UTC via `pg_cron`.

---

## 2. News Radar (announcements automation)

| Table | Purpose |
| --- | --- |
| `news_candidates` | Queue of scored feed items awaiting curation |

Columns: `source`, `source_url`, `title`, `url` (unique), `summary`, `author`,
`published_at`, `matched_keywords[]`, `score`, `status`
(`pending|approved|rejected|posted`), `announcement_id` → `announcements.id`,
`reviewed_by`, `reviewed_at`, `review_notes`, `raw jsonb`.

RLS: admins/curators only for select/update; inserts come from the edge function under the
service role (`INSERT` denied to client roles). Approving writes a row into `announcements`
and links it back via `announcement_id`. Poller: `news-radar-poll`, nightly 03:42 UTC.

See `docs/NEWS_RADAR.md` for the end-to-end diagram.

---

## 3. Social Force Field (three layers)

| Object | Type | Purpose |
| --- | --- | --- |
| `personality_scores` | table | Per-investigator trait vectors: `big_five jsonb`, `hexaco jsonb`, `token_count`, `matched_count`, `top_adjectives jsonb`, `last_computed_at`. Age-of-Acquisition based; LIWC removed. |
| `get_investigator_attention()` | RPC (definer, admin-only) | Joins `analytics_clicks` / `analytics_pageviews` per investigator → attention signal for the cognitive-layer heatmaps |
| cohort grouping | view/derived | Buckets investigators into R61 vs R34 as the shared mental model unit |

Consumed by `CognitiveLayer.tsx` (shared attention bar chart), `CohortHeatmap.tsx`,
`RelationalLayer.tsx` (Jaccard cohesion matrix), `PersonalityBoard.tsx`.
The zodiac experiment was added and then removed — those columns are gone.

---

## 4. Identity / auth fixes (no schema change)

- `investigators.secondary_emails[]` is now honoured on login: `globus-auth` uses
  `.limit(1)` so a member matching multiple rows no longer trips `domain_not_allowed`.
- Institution canonicalizer regex fixed: "Penn State" no longer collapses into
  "University of Pennsylvania".
- Duplicate investigator records are consolidated by migrating `grant_investigators`,
  `investigator_organizations`, and `resource_id` links onto the surviving row.

---

## Conventions to keep

1. Every new `public` table ships `GRANT`s in the same migration as the `CREATE TABLE` —
   PostgREST has no default privileges on `public`.
2. Order is: create table → grants → enable RLS → policies.
3. Roles live only in `user_roles`, checked through `has_role()` / `is_curator_or_admin()`.
4. Schema changes go through migrations; data changes go through the insert path.
