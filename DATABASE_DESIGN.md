# BBQS Database Design Document

> **Architecture**: Resource-Centric Graph Model on Supabase (PostgreSQL 15+)
> **Last Updated**: 2026-03-30

---

## 1. Architecture Overview

The BBQS database follows a **three-layer graph model** designed for multi-tenant neuroscience consortium data:

```
┌─────────────────────────────────────────────────────────┐
│  TENANT LAYER          organizations                    │
│                        ├── allowed_domains              │
│                        └── profiles                     │
├─────────────────────────────────────────────────────────┤
│  NODE LAYER            resources  (central hub)         │
│                        ├── grants                       │
│                        ├── projects                     │
│                        ├── investigators                │
│                        ├── publications                 │
│                        ├── software_tools               │
│                        ├── species                      │
│                        ├── jobs                         │
│                        └── announcements                │
├─────────────────────────────────────────────────────────┤
│  EDGE LAYER            resource_links  (polymorphic)    │
│                        ├── grant_investigators          │
│                        ├── project_publications         │
│                        ├── project_resources            │
│                        └── investigator_organizations   │
└─────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Single tenant axis** — All user-facing objects are scoped to `organization_id` → `organizations`.
2. **Central hub** — The `resources` table is a polymorphic node; domain tables link to it via `resource_id`.
3. **Typed edges** — Canonical relationships use UUID-based join tables; ad-hoc links use `resource_links`.
4. **Audit trail** — `edit_history` captures field-level changes with provenance; `chat_messages` logs AI interactions.

---

## 2. Tenant Layer

### `organizations`

The root tenant entity. Every user, project, and resource is scoped to an organization.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `name` | `text` | No | — | Organization display name |
| `url` | `text` | Yes | — | Organization website |
| `resource_id` | `uuid` | Yes | — | FK → `resources.id` |
| `created_at` | `timestamptz` | No | `now()` | Creation timestamp |

### `allowed_domains`

Maps email domains to organizations for automatic user provisioning.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `domain` | `text` | No | — | Email domain (e.g. `mit.edu`) |
| `organization_id` | `uuid` | No | — | FK → `organizations.id` |
| `created_at` | `timestamptz` | No | `now()` | Creation timestamp |

**Behavior**: On user signup, `handle_new_user()` trigger matches the email domain to auto-assign `organization_id` on the profile.

### `profiles`

One-to-one with `auth.users`. Created automatically via the `handle_new_user()` trigger.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | — | PK, equals `auth.users.id` |
| `email` | `text` | No | — | User email |
| `full_name` | `text` | Yes | — | Display name |
| `organization_id` | `uuid` | Yes | — | FK → `organizations.id` (auto-assigned) |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

---

## 3. Node Layer

### `resources` (Central Hub)

Every domain entity registers a row here. This enables polymorphic queries, cross-entity linking, and a unified comment/embedding system.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `name` | `text` | No | — | Display name |
| `resource_type` | `enum` | No | — | One of: `investigator`, `organization`, `grant`, `publication`, `software`, `tool`, `dataset`, `protocol`, `benchmark`, `ml_model`, `job`, `announcement` |
| `description` | `text` | Yes | — | — |
| `external_url` | `text` | Yes | — | — |
| `metadata` | `jsonb` | Yes | `{}` | Extensible key-value store |
| `organization_id` | `uuid` | Yes | — | FK → `organizations.id` |
| `created_by` | `uuid` | Yes | — | FK → `auth.users.id` |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

### `grants`

NIH grant records. The canonical funding source for projects.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `grant_number` | `text` | No | — | NIH grant number (unique identifier) |
| `title` | `text` | No | — | Grant title |
| `abstract` | `text` | Yes | — | Grant abstract |
| `award_amount` | `numeric` | Yes | — | Total award in USD |
| `fiscal_year` | `integer` | Yes | — | — |
| `nih_link` | `text` | Yes | — | NIH Reporter URL |
| `resource_id` | `uuid` | Yes | — | FK → `resources.id` |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

### `projects`

Consortium project metadata. Each project is linked to a grant via `grant_id`.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `grant_number` | `text` | No | — | Denormalized grant number for fast lookups |
| `grant_id` | `uuid` | Yes | — | FK → `grants.id` (canonical link) |
| `organization_id` | `uuid` | Yes | — | FK → `organizations.id` |
| `resource_id` | `uuid` | Yes | — | FK → `resources.id` |
| `metadata` | `jsonb` | Yes | `{}` | BIDS/NWB metadata fields |
| `metadata_completeness` | `integer` | Yes | `0` | Percentage 0–100 |
| `keywords` | `text[]` | Yes | `{}` | Searchable tags |
| `study_species` | `text[]` | Yes | `{}` | Species studied |
| `study_human` | `boolean` | Yes | `false` | Human subjects flag |
| `website` | `text` | Yes | — | Project website |
| `last_edited_by` | `text` | Yes | — | Email, auth user id or actor label of the last editor. **Not readable by anon** |
| `questionnaire_submitted_by` | `text` | Yes | — | Email of the Data Questionnaire respondent. **Not readable by anon** |
| `questionnaire_submitted_at` | `timestamptz` | Yes | — | When that response was submitted. **Not readable by anon** |
| `questionnaire_response_id` | `text` | Yes | — | Google Forms responseId. **Not readable by anon** |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

**Anon reads named columns only** (20261117190000): anon may SELECT every column above except the four
marked, so an anonymous `select=*` is refused. The questionnaire attribution was three keys inside
`metadata` until then; `trg_aa_keep_questionnaire_attribution_private` moves them into the columns on
every write. The same column-by-column rule covers `investigators_public` (no `user_id`, `pending_role`),
`feature_suggestions_public` (no `submitter_name`, `github_username`), `resources.created_by`,
`announcements.posted_by`, `entity_comments.user_id`, `dandisets` (`raw`, `hidden_reason`, `hidden_by`,
`hidden_at`), `harvester_relations.approved_by` and `harvester_settings.updated_by`; anon may not read
`project_questionnaire_status` at all. A column added later is hidden from anon until a migration runs
`GRANT SELECT (<column>) ON public.<object> TO anon` (tests/guards/anon-private-columns).

### `investigators`

Principal investigators and co-PIs across the consortium.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `name` | `text` | No | — | Full name |
| `email` | `text` | Yes | — | Contact email |
| `orcid` | `text` | Yes | — | ORCID identifier |
| `scholar_id` | `text` | Yes | — | Google Scholar ID |
| `profile_url` | `text` | Yes | — | Personal website |
| `research_areas` | `text[]` | Yes | `{}` | Research focus areas |
| `skills` | `text[]` | Yes | `{}` | Technical skills |
| `user_id` | `uuid` | Yes | — | FK → `auth.users.id` (claimed profile) |
| `resource_id` | `uuid` | Yes | — | FK → `resources.id` |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

**Auto-linking**: The `auto_link_investigator()` trigger matches new users by email to claim their investigator profile.

### `publications`

Research publications linked to projects via the `project_publications` join table.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `title` | `text` | No | — | Paper title |
| `authors` | `text` | Yes | — | Author list |
| `author_orcids` | `jsonb` | Yes | `[]` | Structured ORCID mappings |
| `journal` | `text` | Yes | — | Journal name |
| `year` | `integer` | Yes | — | Publication year |
| `doi` | `text` | Yes | — | Digital Object Identifier |
| `pmid` | `text` | Yes | — | PubMed ID |
| `pubmed_link` | `text` | Yes | — | PubMed URL |
| `citations` | `integer` | Yes | `0` | Citation count |
| `rcr` | `numeric` | Yes | `0` | Relative Citation Ratio |
| `keywords` | `text[]` | Yes | `{}` | — |
| `resource_id` | `uuid` | Yes | — | FK → `resources.id` |
| `created_at` | `timestamptz` | No | `now()` | — |

### `software_tools`

Software and computational tools developed by the consortium.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `name` | `text` | No | — | Tool name |
| `description` | `text` | Yes | — | — |
| `repo_url` | `text` | Yes | — | GitHub/GitLab URL |
| `docs_url` | `text` | Yes | — | Documentation URL |
| `language` | `text` | Yes | — | Primary language |
| `license` | `text` | Yes | — | License type |
| `version` | `text` | Yes | — | Current version |
| `resource_id` | `uuid` | Yes | — | FK → `resources.id` |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

### `species`

Model organisms and species studied across projects.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `name` | `text` | No | — | Scientific name |
| `common_name` | `text` | Yes | — | Common name |
| `taxonomy_class` | `text` | Yes | — | Taxonomic class |
| `taxonomy_order` | `text` | Yes | — | Taxonomic order |
| `taxonomy_family` | `text` | Yes | — | Taxonomic family |
| `taxonomy_genus` | `text` | Yes | — | Taxonomic genus |
| `metadata` | `jsonb` | Yes | `{}` | Additional taxonomy data |
| `resource_id` | `uuid` | Yes | — | FK → `resources.id` |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

### `jobs`

Job postings across consortium institutions.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `title` | `text` | No | — | Job title |
| `institution` | `text` | No | — | Hosting institution |
| `department` | `text` | Yes | — | — |
| `job_type` | `text` | No | `postdoc` | Position type |
| `location` | `text` | Yes | — | — |
| `description` | `text` | Yes | — | Full description |
| `application_url` | `text` | Yes | — | Application link |
| `contact_name` | `text` | Yes | — | — |
| `contact_email` | `text` | Yes | — | — |
| `is_active` | `boolean` | No | `true` | Active listing flag |
| `expires_at` | `timestamptz` | Yes | — | Expiration date |
| `posted_by` | `uuid` | Yes | — | FK → `auth.users.id` |
| `posted_by_email` | `text` | Yes | — | — |
| `organization_id` | `uuid` | Yes | — | FK → `organizations.id` |
| `resource_id` | `uuid` | Yes | — | FK → `resources.id` |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

### `announcements`

Consortium-wide announcements and news.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `title` | `text` | No | — | — |
| `content` | `text` | No | — | Announcement body |
| `link` | `text` | Yes | — | Related URL |
| `link_text` | `text` | Yes | — | Link display text |
| `is_external_link` | `boolean` | No | `false` | — |
| `posted_by` | `uuid` | Yes | — | FK → `auth.users.id` |
| `posted_by_email` | `text` | Yes | — | — |
| `organization_id` | `uuid` | Yes | — | FK → `organizations.id` |
| `resource_id` | `uuid` | Yes | — | FK → `resources.id` |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

---

## 4. Edge Layer

### `grant_investigators` (Grant ↔ Investigator)

| Column | Type | Description |
|--------|------|-------------|
| `grant_id` | `uuid` | FK → `grants.id` |
| `investigator_id` | `uuid` | FK → `investigators.id` (PK) |
| `role` | `text` | `pi` or `co_pi` (default: `co_pi`) |

### `project_publications` (Project ↔ Publication)

| Column | Type | Description |
|--------|------|-------------|
| `project_id` | `uuid` | FK → `projects.id` |
| `publication_id` | `uuid` | FK → `publications.id` |
| `created_at` | `timestamptz` | — |

Composite PK: `(project_id, publication_id)`

### `project_resources` (Project ↔ Resource)

| Column | Type | Description |
|--------|------|-------------|
| `project_id` | `uuid` | FK → `projects.id` |
| `resource_id` | `uuid` | FK → `resources.id` |
| `relationship` | `text` | Default: `uses` |
| `created_at` | `timestamptz` | — |

### `investigator_organizations` (Investigator ↔ Organization)

| Column | Type | Description |
|--------|------|-------------|
| `investigator_id` | `uuid` | FK → `investigators.id` |
| `organization_id` | `uuid` | FK → `organizations.id` |

### `resource_links` (Polymorphic Edges)

For ad-hoc or cross-type relationships not covered by the canonical join tables above.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` | Primary key |
| `source_id` | `uuid` | FK → `resources.id` |
| `target_id` | `uuid` | FK → `resources.id` |
| `relationship` | `text` | Default: `related_to` |
| `metadata` | `jsonb` | Edge attributes |
| `created_at` | `timestamptz` | — |

---

## 5. Chat & AI Layer

### `chat_conversations`

Stores conversation sessions. Metadata assistant conversations use `title = "metadata:{grant_number}"`.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `user_id` | `uuid` | No | — | FK → `auth.users.id` |
| `organization_id` | `uuid` | Yes | — | FK → `organizations.id` |
| `title` | `text` | Yes | — | Convention: `metadata:{grant_number}` |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

**RLS**: Users can only CRUD their own conversations (`auth.uid() = user_id`).

### `chat_messages`

Individual messages within a conversation. Both user and assistant messages are persisted for audit.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `conversation_id` | `uuid` | No | — | FK → `chat_conversations.id` |
| `user_id` | `uuid` | No | — | FK → `auth.users.id` |
| `role` | `text` | No | — | `user` or `assistant` |
| `content` | `text` | No | — | Message text |
| `model` | `text` | Yes | `gpt-4o-mini` | AI model used |
| `tokens_used` | `integer` | Yes | `0` | Token consumption |
| `latency_ms` | `integer` | Yes | `0` | Response latency |
| `context_sources` | `jsonb` | Yes | `[]` | RAG source references |
| `created_at` | `timestamptz` | No | `now()` | — |

**RLS**: Users can only insert and view their own messages.

### `knowledge_embeddings`

Vector embeddings for RAG (Retrieval-Augmented Generation) across all assistants.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `source_type` | `text` | No | — | Entity type (e.g. `grant`, `publication`) |
| `source_id` | `text` | No | — | Source entity ID |
| `title` | `text` | No | — | Chunk title |
| `content` | `text` | No | — | Text chunk |
| `embedding` | `vector` | Yes | — | pgvector embedding |
| `metadata` | `jsonb` | Yes | `{}` | — |
| `resource_id` | `uuid` | Yes | — | FK → `resources.id` |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

**Function**: `search_knowledge_embeddings(query_embedding, match_threshold, match_count)` performs cosine similarity search.

---

## 6. Audit & Provenance

### `edit_history`

Field-level audit log for all metadata changes, with optional AI chat context.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `grant_number` | `text` | No | — | Affected project |
| `project_id` | `uuid` | Yes | — | FK → `projects.id` |
| `field_name` | `text` | No | — | Changed field |
| `old_value` | `jsonb` | Yes | — | Previous value |
| `new_value` | `jsonb` | Yes | — | New value |
| `edited_by` | `text` | No | `anonymous` | Editor identifier |
| `chat_context` | `jsonb` | Yes | — | AI conversation context that triggered the edit |
| `validation_status` | `text` | Yes | — | `pass`, `warn`, `fail` |
| `validation_checks` | `jsonb` | Yes | — | Detailed validation results |
| `created_at` | `timestamptz` | No | `now()` | — |

---

## 7. Supporting Tables

### `funding_opportunities`

NIH funding opportunity announcements tracked for the consortium.

### `feature_suggestions` / `feature_votes`

Internal feature request board with upvoting.

### `ontology_standards`

Reference table of BIDS/NWB ontology standards used for metadata validation.

### `taxonomies`

Hierarchical controlled vocabulary (category → parent_value → value).

### `custom_field_usage`

Tracks non-standard metadata fields to surface for potential canonicalization.

### `state_privacy_rules`

State-by-state data privacy regulation matrix.

### `analytics_pageviews` / `analytics_clicks`

Anonymous usage analytics scoped to organizations.

### `search_queries`

Search query log for discovery analytics.

---

## 8. Security Functions

### `user_can_edit_project(_user_id uuid, _grant_number text) → boolean`

Returns `true` if the user belongs to an MIT-domain org OR if the user's organization has an investigator on the grant. Used by the metadata assistant to enforce edit permissions.

### `user_owns_investigator(_user_id uuid, _investigator_id uuid) → boolean`

Checks if a user has claimed an investigator profile (via `investigators.user_id`).

### `user_owns_resource(_user_id uuid, _resource_id uuid) → boolean`

Checks if a user created a resource (via `resources.created_by`).

### `handle_new_user() → trigger`

Fires on `auth.users` INSERT. Matches email domain → `allowed_domains` → sets `organization_id` on the new profile.

### `auto_link_investigator() → trigger`

Fires on `auth.users` INSERT. Matches email to unclaimed investigator records and sets `user_id`.

---

## 9. Row-Level Security Summary

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| `organizations` | Public | Auth | ✗ | ✗ |
| `profiles` | Public | Own | Own | ✗ |
| `resources` | Public | Auth | Own | Service |
| `grants` | Public | Service | Service | Service |
| `projects` | Public | Public | Public | ✗ |
| `publications` | Public | Service | Service | Service |
| `investigators` | Public | Auth | Auth/Own | ✗ |
| `chat_conversations` | Own | Own | Own | Own |
| `chat_messages` | Own | Own | ✗ | ✗ |
| `edit_history` | Public | Public | ✗ | ✗ |
| `jobs` | Active | Own | Own | Own |
| `announcements` | Public | Own | Own | Own |

**Legend**: Public = no auth required, Auth = authenticated, Own = `auth.uid()` match, Service = service_role only, ✗ = denied

---

## 10. Entity-Relationship Diagram

```
organizations ──────┐
  │                  │
  ├── allowed_domains│
  ├── profiles       │
  │     └── user_id ─┤── chat_conversations
  │                  │     └── chat_messages
  │                  │
  ├── projects ──────┤── project_publications ── publications
  │     │            │── project_resources ────── resources (hub)
  │     └── grant_id │                              │
  │           │      │                              ├── grants
  ├── grants ─┘      │                              ├── investigators
  │     └── grant_investigators ── investigators    ├── software_tools
  │                  │               │              ├── species
  │                  │               └── inv_orgs ──┤── jobs
  │                  │                              └── announcements
  │                  │
  └── edit_history   └── knowledge_embeddings
```

---

## 11. Storage Buckets

| Bucket | Public | Purpose |
|--------|--------|---------|
| `neuromcp-audio` | Yes | Voice agent audio files |
| `paper-uploads` | No | Uploaded research papers (auth required) |

---

## 12. Schema Change Policy

> **Rule**: ALL database schema changes require explicit user approval before execution. No exceptions.

### Governance Principles

1. **No silent schema changes** — Every `CREATE TABLE`, `ALTER TABLE`, `DROP`, `CREATE INDEX`, `CREATE FUNCTION`, `CREATE TRIGGER`, or `CREATE POLICY` must be presented to the user for review before running.
2. **Fit-check first** — Before proposing any schema change, verify it fits the 3-layer architecture:
   - **Does it belong to an existing layer?** (Tenant / Node / Edge / Chat / Audit / Supporting)
   - **If Node Layer**: Does it need a `resource_id` FK → `resources.id`?
   - **If tenant-scoped**: Does it need `organization_id` FK → `organizations.id`?
   - **If user-owned**: Does it need a `user_id` or `posted_by` FK and corresponding RLS?
3. **No orphan tables** — New tables must be documented in this file with their layer assignment, column spec, and RLS summary before the migration runs.
4. **Prefer extension over creation** — Before creating a new table, evaluate whether the data can be stored as:
   - A JSONB field on an existing table (e.g., `metadata` column)
   - A row in `resources` with a new `resource_type` enum value
   - An edge in `resource_links`

### Required Checklist (before any migration)

| # | Check | Required |
|---|-------|----------|
| 1 | Does this change fit an existing layer in the architecture? | ✅ |
| 2 | If new table: is `organization_id` included (if tenant-scoped)? | ✅ |
| 3 | If new domain entity: does it have `resource_id` FK → `resources`? | ✅ |
| 4 | Are RLS policies defined for SELECT, INSERT, UPDATE, DELETE? | ✅ |
| 5 | Are all FK constraints explicit UUIDs (not text-based lookups)? | ✅ |
| 6 | Has `DATABASE_DESIGN.md` been updated with the new schema? | ✅ |
| 7 | Does the migration avoid modifying reserved schemas (`auth`, `storage`, `realtime`)? | ✅ |
| 8 | If adding columns: are new columns nullable or have sensible defaults? | ✅ |
| 9 | If destructive (DROP, rename): is there a data migration plan? | ✅ |

### Change Categories

| Category | Examples | Approval |
|----------|----------|----------|
| **Additive-safe** | Add nullable column, add index, add RLS policy | User approval required |
| **Structural** | New table, new enum value, new trigger/function | User approval required |
| **Destructive** | Drop table/column, rename column, change type | User approval + migration plan required |
| **Blocked** | Modify `auth.*`, `storage.*`, `realtime.*` schemas | Never allowed |

### Process

1. **Propose** — Present the SQL migration with a plain-English summary of what changes and why.
2. **Checklist** — Confirm all items in the checklist above are satisfied.
3. **Approve** — User explicitly approves before execution.
4. **Document** — Update `DATABASE_DESIGN.md` with the new/changed schema.
5. **Verify** — Confirm the migration succeeded and existing queries still work.
