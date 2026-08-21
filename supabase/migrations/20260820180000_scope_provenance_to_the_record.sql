-- Narrow provenance scope to the scientific record. The backfill showed the list was wrong.
-- Constitution Principle XI.
--
-- WHAT THE BACKFILL REVEALED. 91,304 cells, 1.3% verified — and 85% of that denominator came from
-- three tables that are machine output, not the record:
--
--   budget_snapshots               46,924 cells (51% of everything). Derived snapshots.
--   grant_methods_traversal_paths  25,504. Harvester multihop traversal, regenerated per run.
--   harvester_keywords              4,965. Pipeline configuration.
--
-- I built the original exclusion list by reading table NAMES and judging what sounded like data.
-- These three sounded plausible and are not, and the cost was not just a bad percentage: the curator
-- worklist would have opened on 77,000 traversal paths, which is precisely the "table you scroll"
-- that the queue was supposed to replace. A queue nobody can empty is a report.
--
-- ALSO EXCLUDED, same reasoning applied properly this time:
--   pipeline output           grant_methods_evidence, harvester_relations. Same harvester, same
--                             regenerate-per-run lifecycle as the traversal paths.
--   configuration             state_privacy_rules, allowed_domains, budget_config. Knobs.
--   intake, not the record    access_requests. A request is a transient application; the
--                             investigator record it becomes is the thing with provenance.
--   user-submitted opinion    feature_suggestions, entity_comments. Someone's view, not a claim
--                             about the world.
--   access control            user_roles. Who may do what, already covered by data_audit_log; its
--                             provenance question is "who granted this", not "how good is it".
--
-- WHAT STAYS, deliberately: investigators, grants, projects, publications, organizations, species,
-- resources, dandisets, the device catalogue, software_tools, the roster and link tables, profiles,
-- and the site's own published content (announcements, jobs, funding_opportunities, system_alerts).
-- Roughly 11,700 cells — a number a team can actually work down.
--
-- personality_scores (3,470 cells) also stays, and is the clearest case in the whole schema of what
-- this feature is for: big-five and HEXACO numbers COMPUTED from text, currently graded G8 because
-- the job that computes them does not declare itself. It should declare algorithmic (G5) with its
-- function in source_ref, at which point 3,470 cells become honestly labelled in one run rather than
-- verified one at a time.
--
-- THE ORPHANED CLAIMS STAY. field_provenance is append-only and its trigger refuses DELETE, so the
-- ~79,600 claims already written for these tables cannot be removed — and should not be. They are a
-- true record of a backfill that ran. What changes is that the views stop counting them:
-- provenance_coverage already derives its table list from provenance_guardable_tables, so exclusions
-- take effect there automatically, and provenance_worklist is amended below to do the same. It was
-- reading field_provenance_current directly, which would have kept surfacing every excluded table.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260820180000');

-- ── 1. The corrected scope ───────────────────────────────────────────────────────────────────
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
    -- access control: covered by data_audit_log; the question is who granted it, not how good it is
    'user_roles',
    -- personal preferences
    'user_dashboard_layouts', 'working_group_dashboard_defaults',
    -- billing
    'lovable_invoices', 'lovable_user_usage', 'lovable_credit_events',
    -- mirrors of external systems: the truth lives in the system being mirrored, not here.
    -- dandisets is the DANDI archive's own metadata, synced in. grant_dandisets STAYS, because the
    -- link between a grant and a dandiset is a claim this consortium makes itself.
    'slack_channel_members', 'slack_channel_pending', 'slack_channels', 'dandisets'
  ]::text[]
$fn$;

-- -- 2. Ordering that survives everything being G8 -------------------------------------------
-- The queue was ordered worst-grade-first: right in principle, useless in practice. After the
-- backfill nearly every cell is G8, so grade stopped discriminating and the secondary sort (table
-- name, alphabetical) quietly took over -- the live queue opened on `dandisets` and `jobs` ahead of
-- every project and investigator in the consortium.
--
-- So order by what the record IS first, then by grade. The scientific core before the catalogue,
-- the catalogue before the site's own furniture.
CREATE OR REPLACE FUNCTION public.provenance_table_priority(_table text)
RETURNS int LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN _table IN ('projects', 'investigators', 'grants', 'publications', 'species',
                    'organizations', 'grant_investigators', 'investigator_organizations',
                    'project_publications', 'grant_dandisets') THEN 1
    WHEN _table IN ('software_tools', 'device_models', 'device_categories',
                    'device_manufacturers', 'device_class_crosswalk', 'resources',
                    'personality_scores', 'proposed_relations') THEN 2
    ELSE 3
  END
$fn$;

COMMENT ON FUNCTION public.provenance_table_priority(text) IS
  'Queue ordering: 1 the scientific record, 2 the catalogue and derived scores, 3 site furniture. Needed because after a backfill almost every cell is G8 and grade alone no longer sorts anything useful.';

GRANT EXECUTE ON FUNCTION public.provenance_table_priority(text) TO authenticated, service_role;

-- -- 3. The worklist: respect the scope, and be readable ---------------------------------------
-- It read field_provenance_current directly, so every excluded table would have kept appearing.
-- Joining provenance_guardable_tables makes one definition of scope govern both views.
CREATE OR REPLACE VIEW public.provenance_worklist
WITH (security_invoker = true)
AS
SELECT fpc.entity_table,
       fpc.entity_id,
       fpc.entity_column,
       fpc.source_class,
       fpc.source_grade,
       fpc.source_label,
       fpc.value_text,
       fpc.agent_label,
       fpc.recorded_at,
       -- A queue row labelled '03fa7c8c-ffbb-4e31...' is not work, it is a puzzle. The first version
       -- of this view resolved names for six tables, and the ones that actually dominated the queue
       -- were not among them. Link and score tables borrow the name of what they point at.
       coalesce(
         p.grant_number, i.name, g.grant_number, pub.title, o.name, sp.common_name,
         st.name, dc.label, dm.name, dmo.model_name,
         fo.title, an.title, jb.title, res.name, pr.full_name, sa.message,
         psi.name, gii.name,
         left(fpc.entity_id::text, 8) || '...'
       ) AS record_label,
       -- APPENDED, deliberately last. CREATE OR REPLACE VIEW cannot insert a column mid-list: the
       -- first version of this migration put priority before record_label and Postgres read that as
       -- "rename record_label to priority" and refused with 42P16. Same trap that caught the
       -- questionnaire-status view and field_provenance_current earlier in this work -- new columns
       -- go on the end, or the statement is a rename.
       public.provenance_table_priority(fpc.entity_table) AS priority
  FROM public.field_provenance_current fpc
  JOIN public.provenance_guardable_tables gt ON gt.table_name = fpc.entity_table
  LEFT JOIN public.projects       p   ON fpc.entity_table = 'projects'      AND p.id   = fpc.entity_id
  LEFT JOIN public.investigators  i   ON fpc.entity_table = 'investigators' AND i.id   = fpc.entity_id
  LEFT JOIN public.grants         g   ON fpc.entity_table = 'grants'        AND g.id   = fpc.entity_id
  LEFT JOIN public.publications   pub ON fpc.entity_table = 'publications'  AND pub.id = fpc.entity_id
  LEFT JOIN public.organizations  o   ON fpc.entity_table = 'organizations' AND o.id   = fpc.entity_id
  LEFT JOIN public.species        sp  ON fpc.entity_table = 'species'       AND sp.id  = fpc.entity_id
  LEFT JOIN public.software_tools st  ON fpc.entity_table = 'software_tools'        AND st.id  = fpc.entity_id
  LEFT JOIN public.device_categories    dc  ON fpc.entity_table = 'device_categories'    AND dc.id  = fpc.entity_id
  LEFT JOIN public.device_manufacturers dm  ON fpc.entity_table = 'device_manufacturers' AND dm.id  = fpc.entity_id
  LEFT JOIN public.device_models        dmo ON fpc.entity_table = 'device_models'        AND dmo.id = fpc.entity_id
  LEFT JOIN public.funding_opportunities fo ON fpc.entity_table = 'funding_opportunities' AND fo.id = fpc.entity_id
  LEFT JOIN public.announcements  an  ON fpc.entity_table = 'announcements'  AND an.id  = fpc.entity_id
  LEFT JOIN public.jobs           jb  ON fpc.entity_table = 'jobs'           AND jb.id  = fpc.entity_id
  LEFT JOIN public.resources      res ON fpc.entity_table = 'resources'      AND res.id = fpc.entity_id
  LEFT JOIN public.profiles       pr  ON fpc.entity_table = 'profiles'       AND pr.id  = fpc.entity_id
  LEFT JOIN public.system_alerts  sa  ON fpc.entity_table = 'system_alerts'  AND sa.id  = fpc.entity_id
  LEFT JOIN public.personality_scores  ps ON fpc.entity_table = 'personality_scores'  AND ps.id = fpc.entity_id
  LEFT JOIN public.investigators      psi ON psi.id = ps.investigator_id
  LEFT JOIN public.grant_investigators gi ON fpc.entity_table = 'grant_investigators' AND gi.id = fpc.entity_id
  LEFT JOIN public.investigators      gii ON gii.id = gi.investigator_id
 WHERE NOT fpc.is_verified;

COMMENT ON VIEW public.provenance_worklist IS
  'Every in-scope cell no human or registry stands behind, with a human-readable name for its record. Scope comes from provenance_guardable_tables, so excluding a table leaves the queue and the coverage figure together. Order by priority, then source_grade DESC: after a backfill almost everything is G8, so grade alone sorts nothing.';

GRANT SELECT ON public.provenance_worklist TO authenticated;

-- -- 4. Detach the guard from tables that just left scope ------------------------------------
-- Nothing removes a trigger when a table is excluded, so without this they would keep recording
-- claims that the views no longer show — a store growing with rows nobody reads.
CREATE OR REPLACE FUNCTION public.provenance_detach_out_of_scope()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _t text;
  _n int := 0;
BEGIN
  FOR _t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_trigger t ON t.tgrelid = c.oid
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND t.tgname = 'trg_enforce_field_provenance' AND NOT t.tgisinternal
       AND c.relname = ANY (public.provenance_excluded_tables())
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_enforce_field_provenance ON public.%I', _t);
    RAISE NOTICE 'provenance guard detached from % (now out of scope)', _t;
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.provenance_detach_out_of_scope() TO service_role;

SELECT public.provenance_detach_out_of_scope() AS triggers_removed;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Coverage, in scope only. Expect roughly 11,700 cells and about 10% verified — a real number,
--    and one a team can move.
SELECT sum(cells) AS cells, sum(verified) AS verified,
       round(100.0 * sum(verified) / nullif(sum(cells), 0), 1) AS pct_verified
  FROM public.provenance_coverage;

SELECT * FROM public.provenance_coverage WHERE cells > 0 ORDER BY unverified DESC;

-- 2) The three offenders are gone from both views.
SELECT count(*) AS out_of_scope_in_worklist_should_be_0
  FROM public.provenance_worklist
 WHERE entity_table IN ('budget_snapshots', 'grant_methods_traversal_paths', 'harvester_keywords');

-- 3) No excluded table still carries the trigger.
SELECT c.relname AS still_guarded_but_excluded
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_trigger t ON t.tgrelid = c.oid
 WHERE n.nspname = 'public' AND t.tgname = 'trg_enforce_field_provenance'
   AND NOT t.tgisinternal AND c.relname = ANY (public.provenance_excluded_tables());

-- 4) The orphaned claims are still on record, as an append-only store requires. This is the count
--    that will never go down, and that is correct: the backfill did happen.
SELECT count(*) AS orphaned_claims_retained
  FROM public.field_provenance
 WHERE entity_table = ANY (public.provenance_excluded_tables());
