-- Whether a welcome email fired is not a claim about the world. Stop asking curators to vouch for it.
--
-- MEASURED. The review queue holds 8,099 cells. 1,957 of them (24%) are the system's own operational
-- state, not information about anything:
--
--   investigators        1,071   reminder_count (240), onboarding_checklist.* (~800),
--                                onboarding_completed_at (28), last_reminder_sent_at, pending_role
--   personality_scores     678   token_count, matched_count, last_computed_at
--   profiles                85   theme_preference  <- a UI colour setting, graded G8
--   projects                62   metadata_completeness, onboarding_status
--   device_models           35   first_seen_at
--   announcements           12   is_external_link
--   system_alerts            8   resolved, resolved_at, email_sent, email_sent_at, occurrence_count...
--   jobs                     6   is_active
--
-- WHY IT MATTERS BEYOND NOISE. investigators reads 1.1% verified, which looks like a data-quality
-- disaster. It is not: 1,071 of its 2,350 queued cells CANNOT be verified by anyone, because
-- "reminder_count = 3" is a fact about our mailer, not about the investigator. The percentage could
-- never climb, so the number taught the reader nothing and the queue buried the ~1,300 cells that
-- are real claims (name, email, institution, orcid) under bookkeeping nobody will ever action.
--
-- THIS IS THE THIRD TIME. Foreign keys (20260822160000), source markers already in the record
-- (20260822150000), and now workflow state. Same root cause every time: provenance_backfill_unknown()
-- swept every column of every in-scope table and stamped what it did not recognise as G8 "no recorded
-- source". Breadth was the point -- Principle XI says unmarked is not fact -- but breadth without a
-- notion of what a claim IS produces confident noise, and each round was caught by the user reading
-- a screen rather than by anything I wrote.
--
-- WHAT IS DELIBERATELY LEFT ALONE, because excluding a real claim hides it from the accountability
-- system entirely, which is worse than leaving it noisy:
--   * status (16: funding_opportunities, proposed_relations) -- "is this FOA open" is a fact about
--     the world; on proposed_relations it is workflow. Same column name, different meanings, so a
--     global exclusion would be wrong. Needs a per-table rule, or leaving be.
--   * key / legacy_key / category_key (64: device_categories, device_class_crosswalk) -- stable
--     identifiers. Arguably bookkeeping, but they are also the join keys a human would check.
--   * publications.keywords, publications.author_orcids (52) -- left unclaimed on purpose in
--     20260822150000: keywords may be hand-added and ORCIDs matched rather than supplied.
--   * personality_scores.hexaco.*, big_five.*, top_adjectives (2,566) -- these ARE claims and must
--     stay. They are machine output presented as "no recorded source", which is a MIS-GRADE, not
--     noise. Fixed separately in 20260822180000 by declaring them algorithmic (G5).
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260822170000');

-- ── 1. Operational state is not content ─────────────────────────────────────────────────────
/** Columns that are bookkeeping rather than content. Grading these would bury the cells that
 *  matter under rows nobody reads: an updated_at changes on every write by definition.
 *
 *  Matched on the part before the first dot, so naming a jsonb column here also excludes every key
 *  inside it -- 'onboarding_checklist' covers onboarding_checklist.slack, .welcome_email and the
 *  rest, which is ~800 of the cells this removes. */
CREATE OR REPLACE FUNCTION public.provenance_excluded_columns()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    -- identity and audit trail
    'id', 'created_at', 'updated_at',
    'last_edited_by', 'edited_by', 'updated_by', 'created_by',
    -- derived search structures, regenerated wholesale
    'search_vector', 'embedding', 'tsv',
    -- onboarding and reminder workflow: the state of OUR process, not facts about the person
    'onboarding_checklist', 'onboarding_completed_at', 'onboarding_status',
    'reminder_count', 'last_reminder_sent_at', 'pending_role', 'requested_working_groups',
    -- personal UI preferences
    'theme_preference',
    -- values computed from other cells; grading them double-counts the inputs
    'metadata_completeness', 'token_count', 'matched_count', 'last_computed_at',
    -- harvester and alerting bookkeeping
    'first_seen_at', 'last_seen_at', 'occurrence_count', 'fingerprint',
    'resolved', 'resolved_at', 'email_sent', 'email_sent_at',
    -- display flags
    'is_active', 'is_external_link'
  ]::text[]
$fn$;

COMMENT ON FUNCTION public.provenance_excluded_columns() IS
  'Columns that are bookkeeping rather than content, matched on the part before the first dot so naming a jsonb column excludes its keys too. A cell earns a provenance claim only if a person could in principle check it against something; reminder_count and theme_preference cannot be checked, and grading them held investigators at a meaningless 1.1% verified while burying the ~1,300 cells that are real claims.';

GRANT EXECUTE ON FUNCTION public.provenance_excluded_columns() TO authenticated, service_role;

-- ── 2. An error log is a log ─────────────────────────────────────────────────────────────────
-- system_alerts is error tracking -- fingerprint, occurrence_count, resolved, email_sent. It belongs
-- with the other append-only logs, not in a queue a curator reads.
CREATE OR REPLACE FUNCTION public.provenance_excluded_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    -- the mechanism itself: recording provenance about provenance recurses
    'field_provenance', 'source_classes',
    -- append-only logs: a log row is already a historical assertion, with no current value to grade
    'data_audit_log', 'auth_audit_log', 'edit_history', 'curation_audit_log',
    'analytics_clicks', 'analytics_pageviews', 'search_queries', 'security_audit_results',
    'system_alerts',
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
    -- mirrors of external systems: the truth lives in the system being mirrored
    'slack_channel_members', 'slack_channel_pending', 'slack_channels', 'dandisets',
    -- pure link tables: foreign keys only, so no cell a human can judge (20260822160000)
    'investigator_organizations', 'project_publications'
  ]::text[]
$fn$;

SELECT public.provenance_detach_out_of_scope() AS triggers_removed;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) The queue should drop from 8,099 to about 6,142.
SELECT count(*) AS queue_size FROM public.provenance_worklist;

-- 2) None of the excluded columns may survive in it. Expect 0.
SELECT count(*) AS bookkeeping_still_queued
  FROM public.provenance_worklist
 WHERE split_part(entity_column, '.', 1) = ANY (public.provenance_excluded_columns());

-- 3) investigators: ~2,350 cells becomes ~1,279, all of them real claims about a person.
--    The verified PERCENTAGE rises only because the denominator stops containing fiction.
SELECT table_name, cells, verified, pct_verified
  FROM public.provenance_coverage
 WHERE table_name IN ('investigators', 'profiles', 'projects', 'personality_scores')
 ORDER BY table_name;

-- 4) What investigators still asks a human to confirm -- should be name, email, institution,
--    role, working_groups, secondary_emails, orcid, profile_url, research_areas, skills. No
--    onboarding_checklist, no reminder_count.
SELECT entity_column, count(*) AS cells
  FROM public.provenance_worklist
 WHERE entity_table = 'investigators'
 GROUP BY entity_column ORDER BY cells DESC;

-- 5) Nothing real was swept away: these must all still be present and gradable.
SELECT public.provenance_is_gradable_column('name')          AS name_expect_true,
       public.provenance_is_gradable_column('institution')   AS institution_expect_true,
       public.provenance_is_gradable_column('orcid')          AS orcid_expect_true,
       public.provenance_is_gradable_column('study_species')  AS species_expect_true,
       public.provenance_is_gradable_column('reminder_count') AS reminder_expect_false,
       public.provenance_is_gradable_column('onboarding_checklist.slack') AS checklist_expect_false;
