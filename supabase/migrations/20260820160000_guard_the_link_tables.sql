-- Close the last coverage gap: link tables the guard could not address.
-- Constitution Principles X and XI.
--
-- WHY. 20260820150000 guarded every table with a uuid `id` — 36 of them, 0 unguarded. But nine
-- tables have no uuid id at all, so they were never candidates, and the coverage report said
-- "0 unguarded" while quietly meaning "0 of the ones we can see". Five of the nine hold curated
-- consortium data:
--
--   grant_investigators         104 rows. Holds `role` and `role_source` — the roster, and the very
--                               field whose vocabulary had to be canonicalised in migration
--                               20260811120000. If any column in this schema deserves provenance it
--                               is this one.
--   investigator_organizations   88 rows. Who is affiliated with what.
--   personality_scores          226 rows. big_five / hexaco, COMPUTED from text. Machine-derived
--                               data presented as fact is exactly what Principle XI exists for, so
--                               leaving it ungraded was the worst of the nine.
--   project_publications          2 rows. Links the publication record to the project record.
--   grant_dandisets               1 row. Already carries a match_source column, i.e. someone
--                               already felt the need for provenance here and hand-rolled one field
--                               of it.
--
-- HOW. field_provenance.entity_id is uuid, so a composite-keyed row cannot be addressed. Rather than
-- widen the store to a composite key — which would complicate every read for five small tables —
-- each gets a surrogate `id uuid UNIQUE DEFAULT gen_random_uuid()`. The existing primary keys are
-- untouched, so no foreign key or RLS policy changes; the tables simply become visible to
-- provenance_guardable_tables and the guard attaches itself. Total rows affected: 421.
--
-- Note the mechanism proving itself: ALTER TABLE fires the ddl_command_end event trigger installed
-- by the previous migration, which attaches the guard without being asked. provenance_attach_all()
-- is called at the end anyway, because relying on a side effect to do the main job is how coverage
-- drifts.
--
-- DEFAULT ON, opt out by name. The other four of the nine are named below, each with a reason. This
-- list is the same one 20260820150000 defined, plus those four; the earlier entries keep their
-- earlier rationale:
--
--   the mechanism itself      field_provenance, source_classes -- recording provenance about
--                             provenance recurses.
--   append-only logs          data_audit_log, auth_audit_log, edit_history, curation_audit_log,
--                             analytics_*, search_queries, security_audit_results. A log row is
--                             already a historical assertion; it has no "current value" to grade.
--   derived bulk              knowledge_embeddings. Regenerated wholesale, and a vector has no
--                             human-meaningful provenance beyond the row it came from.
--   derived summaries         cohort_summaries. Regenerated from the grants it summarises; grading
--                             it would grade a copy instead of the source.
--   pipeline state            harvester_queue, harvester_runs, news_candidates. Rewritten every run.
--   operational config        harvester_settings. Knobs, not the record — and its id is not a uuid.
--   moderation state          group_audit_dismissals. Records that a human dismissed a finding,
--                             which is a decision about the data rather than the data.
--   personal preferences      user_dashboard_layouts, working_group_dashboard_defaults. Not the
--                             scientific record.
--   individual opinions       feature_votes. A vote is not a claim about the world.
--   billing                   lovable_invoices, lovable_user_usage, lovable_credit_events.
--   external snapshots        slack_channel_members, slack_channel_pending, slack_channels. A
--                             mirror of Slack, replaced by each survey; the truth lives in Slack.
--
-- Anything not named here is guarded, including tables that do not exist yet.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260820160000');
SELECT public.set_source_class('curator_fill');

-- ── 1. Surrogate keys so the guard can address these rows ────────────────────────────────────
ALTER TABLE public.grant_investigators        ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE public.investigator_organizations ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE public.personality_scores         ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE public.project_publications       ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE public.grant_dandisets            ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();

-- Backfill any row that predates the default, then make it dependable. NOT NULL and UNIQUE are what
-- let the guard treat `id` as an address rather than a hint.
DO $do$
DECLARE
  _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['grant_investigators', 'investigator_organizations',
                            'personality_scores', 'project_publications', 'grant_dandisets'] LOOP
    EXECUTE format('UPDATE public.%I SET id = gen_random_uuid() WHERE id IS NULL', _t);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN id SET NOT NULL', _t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = _t || '_id_key' AND conrelid = ('public.' || _t)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (id)', _t, _t || '_id_key');
    END IF;
  END LOOP;
END
$do$;

COMMENT ON COLUMN public.grant_investigators.id IS
  'Surrogate key, added so per-cell provenance can address this row. The composite primary key (grant_id, investigator_id) is unchanged and is still the identity of the link.';

-- ── 2. Name the four that stay out ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provenance_excluded_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    'field_provenance', 'source_classes',
    'data_audit_log', 'auth_audit_log', 'edit_history', 'curation_audit_log',
    'analytics_clicks', 'analytics_pageviews', 'search_queries', 'security_audit_results',
    'knowledge_embeddings', 'cohort_summaries',
    'harvester_queue', 'harvester_runs', 'news_candidates', 'harvester_settings',
    'group_audit_dismissals', 'feature_votes',
    'user_dashboard_layouts', 'working_group_dashboard_defaults',
    'lovable_invoices', 'lovable_user_usage', 'lovable_credit_events',
    'slack_channel_members', 'slack_channel_pending', 'slack_channels'
  ]::text[]
$fn$;

-- ── 3. Attach ────────────────────────────────────────────────────────────────────────────────
SELECT public.provenance_attach_all() AS tables_newly_guarded;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Coverage, and this time the number means what it says. unguarded MUST be 0.
SELECT count(*) FILTER (WHERE is_guarded)     AS guarded,
       count(*) FILTER (WHERE NOT is_guarded) AS unguarded_must_be_0
  FROM public.provenance_guardable_tables;

-- 2) The five new arrivals should be present and guarded.
SELECT table_name, is_guarded
  FROM public.provenance_guardable_tables
 WHERE table_name IN ('grant_investigators', 'investigator_organizations', 'personality_scores',
                      'project_publications', 'grant_dandisets')
 ORDER BY table_name;

-- 3) NOTHING should be left in the gap: every public table is now either guarded or excluded on
--    purpose. This is the query whose answer was silently 9 before this migration.
SELECT c.relname AS neither_guarded_nor_excluded
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND NOT (c.relname = ANY (public.provenance_excluded_tables()))
   AND c.relname NOT IN (SELECT table_name FROM public.provenance_guardable_tables)
 ORDER BY 1;

-- 4) The roster's role field is now addressable. Once anything updates a row here, a claim appears.
SELECT count(*) AS grant_investigator_rows,
       count(*) FILTER (WHERE id IS NOT NULL) AS with_surrogate_key
  FROM public.grant_investigators;
