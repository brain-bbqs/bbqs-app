-- Correct the stated reason for excluding pure link tables. The list is UNCHANGED — same 43 names,
-- same order. Only the comment moves.
--
-- 20260822160000 gave two reasons: the row is foreign keys and nothing else, so no cell a human can
-- judge; and "the guard is BEFORE UPDATE and link rows are inserted or deleted, never updated, so it
-- never fired here anyway". The second was true when written and is now false — 20260831160000
-- added trg_record_field_provenance AFTER INSERT, and link rows are inserted.
--
-- Left standing, that sentence reads as "link tables are excluded because provenance cannot reach
-- them", which would invite someone to remove them from this list on the grounds that it now can.
-- The first reason is the real one and it survives on its own. provenance_excluded_tables is
-- replaced wholesale by every migration that touches it, so a comment cannot be corrected in place.
--
-- Whether a link's INSERT is itself a claim worth recording -- "RePORTER says this publication
-- belongs to this project" -- is a live question, deliberately not settled here. data_audit_log
-- already records the insert and who did it.
--
-- Apply MANUALLY in the KG SQL editor.

SELECT public.set_actor('migration:20260831_link_table_exclusion_reason');

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
    -- PURE LINK TABLES: foreign keys and nothing else, so no cell a human can judge -- grading them
    -- protected nothing while filling the worklist with uuids (20260822160000). This is now the
    -- ONLY reason. The old second reason -- that the guard is BEFORE UPDATE and link rows are never
    -- updated, so it could not fire here -- expired when 20260831160000 added an AFTER INSERT
    -- recorder. Provenance CAN reach these tables now; they are excluded because the cells are not
    -- worth judging, not because it cannot.
    -- grant_investigators and grant_dandisets are NOT in this group -- they carry attributes.
    'investigator_organizations', 'project_publications'
  ]::text[]
$fn$;

-- Same 43 names as before, and coverage unchanged: expect 24 tables, all true/true.
SELECT array_length(public.provenance_excluded_tables(), 1) AS excluded_count;

SELECT count(*) FILTER (WHERE is_guarded AND is_recorded) AS fully_covered,
       count(*)                                           AS guardable
  FROM public.provenance_guardable_tables;
