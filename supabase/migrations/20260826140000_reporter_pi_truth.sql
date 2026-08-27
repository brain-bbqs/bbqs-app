-- A temporal record of what RePORTER says about who the PIs are.
--
-- REQUEST (Satra, 2026-08-26): "all pis should be determined from reporter for a project as the
-- authoritative source... the set of mpis from reporter could change over time, so all versions of a
-- project should be inspected in temporal order to determine current PIs. (more generally this kind
-- of workflow should be automated as a function talking to the reporter API) producing/updating a
-- primary ground truth data file."
--
-- WHY A SNAPSHOT TABLE AND NOT A LIVE QUERY. RePORTER returns one row per BUDGET YEAR, and the PI
-- list belongs to the year, not the project. `nih-grants`' reconcile action asked for `limit: 1` and
-- took whatever came back — i.e. one arbitrary year — and wrote that over the roster. Storing every
-- year makes "current PIs" a derivation (`reporter_pi_current`, newest fiscal year) instead of an
-- accident of pagination, and makes a handover visible instead of silently overwriting.
--
-- MEASURED, 2026-08-26, 31 core projects / 57 project-years: exactly one project has drifted, and it
-- is a contact-PI handover, not a change of roster —
--   R61MH135405  FY2024 contact = Joshua Jacobs
--                FY2025 contact = Brett E Youngerman   (FY2026 unchanged)
-- The four PIs are the same all three years. So Satra's wrinkle is real and already present, and it
-- is the CONTACT flag that moves, which is precisely the bit a "latest row wins" sync would flip
-- back and forth depending on which year it happened to read.
--
-- IDENTITY IS profile_id, NOT THE NAME. Every RePORTER PI carries a stable `profile_id`
-- (Alex Williams = 'Alexander Henry Williams' = 8994503-style id). Name matching is what made
-- 28 of our PIs look like different people from their own award records, and what makes
-- `nih-grants` reconcile silently DROP a PI it cannot match (`if (!inv) continue`). The
-- reporter_profile_id column added here is the anchor that ends that class of bug.
--
-- NOTHING HERE WRITES TO grant_investigators. Roster changes drive pi@ entitlement; this migration
-- only records what RePORTER says and shows where the KG disagrees. Applying it is a separate,
-- deliberate act — see the reporter-pi-sync function's `reconcile` action, which is dry-run by
-- default.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260826140000');

-- ── 1. The identity anchor ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.investigators
  ADD COLUMN IF NOT EXISTS reporter_profile_id bigint;

COMMENT ON COLUMN public.investigators.reporter_profile_id IS
  'NIH RePORTER profile_id for this person. Stable across awards and across name forms, which the name is not: RePORTER carries the legal name ("Alexander Henry Williams", "KOSTAS  DANIILIDIS") where this table carries the one people use. Set it once and PI reconciliation stops guessing.';

-- Partial unique: many rows are legitimately NULL, but one profile_id must not map to two people.
CREATE UNIQUE INDEX IF NOT EXISTS uq_investigators_reporter_profile_id
  ON public.investigators (reporter_profile_id) WHERE reporter_profile_id IS NOT NULL;

-- ── 2. Every project-year RePORTER has told us about ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reporter_pi_observations (
  core_project_num  text        NOT NULL,
  fiscal_year       int         NOT NULL,
  profile_id        bigint      NOT NULL,
  project_num       text,               -- the application id for that year, e.g. 5R34DA059507-02
  award_notice_date date,
  full_name         text        NOT NULL,
  first_name        text,
  last_name         text,
  is_contact_pi     boolean     NOT NULL DEFAULT false,
  title             text,
  observed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (core_project_num, fiscal_year, profile_id)
);

COMMENT ON TABLE public.reporter_pi_observations IS
  'What NIH RePORTER reported about a project''s principal investigators, one row per (core project, fiscal year, person). A mirror of an external registry, not a curated claim: re-fetching is how it is corrected, so it carries no provenance grade. reporter_pi_current derives "who the PIs are now" from the newest fiscal year.';

CREATE INDEX IF NOT EXISTS idx_reporter_pi_obs_profile ON public.reporter_pi_observations (profile_id);
CREATE INDEX IF NOT EXISTS idx_reporter_pi_obs_year    ON public.reporter_pi_observations (core_project_num, fiscal_year DESC);

ALTER TABLE public.reporter_pi_observations ENABLE ROW LEVEL SECURITY;

-- Readable by anyone signed in: it is public federal award data, and the curator queue needs it.
-- Writable only by the service role, i.e. only by the sync function.
DROP POLICY IF EXISTS reporter_pi_obs_read ON public.reporter_pi_observations;
CREATE POLICY reporter_pi_obs_read ON public.reporter_pi_observations
  FOR SELECT TO authenticated USING (true);

-- ── 3. Current PIs = the newest fiscal year on record ──────────────────────────────────────────
CREATE OR REPLACE VIEW public.reporter_pi_current
WITH (security_invoker = true)
AS
WITH newest AS (
  SELECT core_project_num, max(fiscal_year) AS fiscal_year
    FROM public.reporter_pi_observations
   GROUP BY core_project_num
)
SELECT o.core_project_num,
       o.fiscal_year,
       o.project_num,
       o.award_notice_date,
       o.profile_id,
       o.full_name,
       o.is_contact_pi,
       -- Every PI on the award is a PI. RePORTER draws exactly one distinction — who is the CONTACT
       -- PI — so that is the only distinction the KG can honestly derive from it. co_pi and mpi are
       -- our invention, and the two mpi rows we hold are the only two the registry does not confirm.
       CASE WHEN o.is_contact_pi THEN 'contact_pi' ELSE 'co_pi' END AS roster_role
  FROM public.reporter_pi_observations o
  JOIN newest n ON n.core_project_num = o.core_project_num AND n.fiscal_year = o.fiscal_year;

COMMENT ON VIEW public.reporter_pi_current IS
  'The PIs of each project as of the most recent fiscal year RePORTER has published. This is the ground truth for "who are the PIs" — derived from the temporal record rather than from whichever budget year a sync happened to read.';

GRANT SELECT ON public.reporter_pi_current TO authenticated;

-- ── 4. Where the KG disagrees with the registry ────────────────────────────────────────────────
-- Read-only. Nothing acts on this without a human asking it to.
CREATE OR REPLACE VIEW public.reporter_pi_drift
WITH (security_invoker = true)
AS
WITH truth AS (
  SELECT c.*, g.id AS grant_id
    FROM public.reporter_pi_current c
    JOIN public.grants g ON g.grant_number = c.core_project_num
), kg AS (
  SELECT g.grant_number, gi.investigator_id, gi.role, gi.role_source,
         i.name, i.reporter_profile_id
    FROM public.grant_investigators gi
    JOIN public.grants        g ON g.id = gi.grant_id
    JOIN public.investigators i ON i.id = gi.investigator_id
   WHERE lower(gi.role) IN ('pi', 'contact_pi', 'co_pi', 'mpi')
)
SELECT coalesce(t.core_project_num, k.grant_number)                     AS grant_number,
       coalesce(t.full_name, k.name)                                    AS person,
       t.profile_id,
       k.role                                                           AS kg_role,
       t.roster_role                                                    AS reporter_role,
       k.role_source                                                    AS kg_role_source,
       t.fiscal_year                                                    AS reporter_fiscal_year,
       CASE
         WHEN k.investigator_id IS NULL THEN 'missing_from_kg'
         WHEN t.profile_id IS NULL      THEN 'not_in_reporter'
         WHEN lower(k.role) <> t.roster_role THEN 'role_differs'
         ELSE 'agrees'
       END                                                              AS drift
  FROM truth t
  FULL OUTER JOIN kg k
    ON k.grant_number = t.core_project_num
   AND k.reporter_profile_id = t.profile_id;

COMMENT ON VIEW public.reporter_pi_drift IS
  'KG roster vs RePORTER''s current PIs, joined on reporter_profile_id. Rows read "missing_from_kg" (RePORTER says PI, we do not), "not_in_reporter" (we say PI, RePORTER does not — our two curator-added mpi rows on R34DA062119), or "role_differs" (usually a contact-PI handover). Anyone not yet carrying a reporter_profile_id shows on BOTH sides until that column is filled.';

GRANT SELECT ON public.reporter_pi_drift TO authenticated;

-- ── 5. Keep the mirror out of the provenance system ────────────────────────────────────────────
-- "The truth lives in the system being mirrored" — same reasoning as slack_channels and dandisets.
-- A curator cannot verify a RePORTER row; re-fetching is how it is corrected.
CREATE OR REPLACE FUNCTION public.provenance_excluded_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    -- the mechanism itself: recording provenance about provenance recurses
    'field_provenance', 'source_classes',
    -- append-only logs: a log row is already a historical assertion, with no current value to grade
    'data_audit_log', 'auth_audit_log', 'edit_history', 'curation_audit_log',
    'analytics_clicks', 'analytics_pageviews', 'search_queries', 'security_audit_results',
    -- derived bulk, regenerated wholesale
    'knowledge_embeddings', 'cohort_summaries', 'budget_snapshots',
    -- harvester pipeline: output and state, rewritten every run
    'harvester_queue', 'harvester_runs', 'harvester_settings', 'harvester_keywords',
    'harvester_synonyms', 'harvester_relations',
    'grant_methods_traversal_paths', 'grant_methods_evidence', 'news_candidates',
    -- configuration: knobs, not the record
    'state_privacy_rules', 'allowed_domains', 'budget_config',
    -- intake and moderation state: decisions about data rather than data
    'access_requests', 'group_audit_dismissals',
    -- user-submitted opinion, not a claim about the world
    'feature_suggestions', 'feature_votes', 'entity_comments',
    -- access control: covered by data_audit_log; the question is who granted it
    'user_roles',
    -- personal preferences
    'user_dashboard_layouts', 'working_group_dashboard_defaults',
    -- billing
    'lovable_invoices', 'lovable_user_usage', 'lovable_credit_events',
    -- mirrors of external systems: the truth lives in the system being mirrored. reporter_pi_
    -- observations is added here by 20260826140000 -- a curator cannot verify a RePORTER row, and
    -- re-fetching is how it is corrected.
    'slack_channel_members', 'slack_channel_pending', 'slack_channels', 'dandisets',
    'reporter_pi_observations',
    -- PURE LINK TABLES: foreign keys and nothing else, so no cell a human can judge. The guard is
    -- BEFORE UPDATE and link rows are inserted or deleted, never updated, so it never fired here
    -- anyway. grant_investigators and grant_dandisets are NOT in this group -- they carry attributes.
    'investigator_organizations', 'project_publications'
  ]::text[]
$fn$;

SELECT public.provenance_detach_out_of_scope() AS triggers_removed;

-- ── Verify ─────────────────────────────────────────────────────────────────────────────────────
-- Empty until reporter-pi-sync runs; these prove the shapes exist and the scope is right.
SELECT count(*) AS observations FROM public.reporter_pi_observations;
SELECT count(*) AS current_pis  FROM public.reporter_pi_current;
SELECT count(*) AS drift_rows   FROM public.reporter_pi_drift;

-- The mirror must not appear in the curator queue or the coverage report.
SELECT 'reporter_pi_observations' = ANY(public.provenance_excluded_tables()) AS excluded;   -- true
SELECT count(*) AS should_be_zero FROM public.provenance_coverage
 WHERE table_name = 'reporter_pi_observations';

-- The anchor exists and is unique where set.
SELECT count(*) AS investigators_with_profile_id
  FROM public.investigators WHERE reporter_profile_id IS NOT NULL;
