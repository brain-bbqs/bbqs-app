-- Remove updated_at from tables that are never UPDATEd, and one duplicated created_at.
--
-- WHY. Migration 20260810160000 added updated_at + a touch trigger to 19 tables that lacked it. That
-- was applied uniformly rather than because anything needed it, and the same test that killed the
-- per-table updated_by should have been applied here too: does this column ever hold a value the row
-- does not already have?
--
-- Measured from pg_stat_user_tables, whose counters have been accumulating for 246 days
-- (stats_reset 2025-12-08) — longer than the oldest row in the database (2026-02-19), so these are
-- lifetime totals, not a sample:
--
--   UPDATED, so updated_at earns its place:
--     personality_scores              688 updates
--     grant_investigators             154      <- role changes; the contact_pi case lived here
--     publications                     56
--     grant_methods_traversal_paths    15
--     grant_methods_evidence           12
--     investigator_organizations        6
--     cohort_summaries                  2
--     harvester_settings                2
--
--   NEVER updated in 246 days — 0 updates each:
--     allowed_domains, budget_snapshots, feature_votes, grant_dandisets, group_audit_dismissals,
--     harvester_relations, harvester_synonyms, organizations, project_publications,
--     proposed_relations, user_roles
--
-- On those 11, updated_at can only ever equal created_at, and the trigger can only ever fire never.
-- It is worse than useless: a reader who sees updated_at assumes it means something, so a column that
-- structurally cannot differ misinforms. Two are actively misleading about their own shape:
--   user_roles      93 inserts, 1 delete, 0 updates — roles are GRANTED and REVOKED, never edited.
--                   The right instrument there is the audit trigger added in 20260810160000, which
--                   captures who granted admin. updated_at answers a question nobody asks.
--   grant_dandisets 81 inserts, 80 deletes, 1 live row — rebuilt by delete-and-insert, so created_at
--                   already IS the last-changed time.
--
-- created_at stays everywhere. It is the cheapest possible fact, it cannot be derived from the audit
-- log for rows predating the trigger (data_audit_log starts 2026-07-24, months after the oldest row),
-- and it is actively read — onboarding_pipeline computes days_since_created > 14 for stuck detection.
--
-- The one exception: group_audit_dismissals already had dismissed_at, which is the same fact as
-- created_at for a row that exists solely to record a dismissal. Two columns for one fact invites the
-- question of which is authoritative, so created_at goes.
--
-- Nothing here is hard to reverse: if one of these tables starts being edited, re-adding updated_at
-- is a one-line migration, and the audit log records the change either way in the meantime.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260810180000');

DO $do$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'allowed_domains', 'budget_snapshots', 'feature_votes', 'grant_dandisets',
    'group_audit_dismissals', 'harvester_relations', 'harvester_synonyms', 'organizations',
    'project_publications', 'proposed_relations', 'user_roles'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS update_%s_updated_at ON public.%I', t, t);
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS updated_at', t);
  END LOOP;
END
$do$;

-- dismissed_at already records when the row was created.
ALTER TABLE public.group_audit_dismissals DROP COLUMN IF EXISTS created_at;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) The 11 should now report updated_at = false and touch_trigger = 0.
SELECT c.relname AS table_name,
       bool_or(a.attname = 'created_at') AS created_at,
       bool_or(a.attname = 'updated_at') AS updated_at,
       (SELECT count(*) FROM pg_trigger t
         WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
           AND t.tgname LIKE 'update_%_updated_at') AS touch_trigger
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE n.nspname = 'public'
   AND c.relname IN ('allowed_domains', 'budget_snapshots', 'feature_votes', 'grant_dandisets',
                     'group_audit_dismissals', 'harvester_relations', 'harvester_synonyms',
                     'organizations', 'project_publications', 'proposed_relations', 'user_roles')
 GROUP BY c.relname, c.oid
 ORDER BY 1;

-- 2) The 8 genuinely-updated tables keep theirs: all should be true / 1.
SELECT c.relname AS table_name,
       bool_or(a.attname = 'updated_at') AS updated_at,
       (SELECT count(*) FROM pg_trigger t
         WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
           AND t.tgname LIKE 'update_%_updated_at') AS touch_trigger
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE n.nspname = 'public'
   AND c.relname IN ('personality_scores', 'grant_investigators', 'publications',
                     'grant_methods_traversal_paths', 'grant_methods_evidence',
                     'investigator_organizations', 'cohort_summaries', 'harvester_settings')
 GROUP BY c.relname, c.oid
 ORDER BY 1;
