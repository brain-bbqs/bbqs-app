-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261117174500_revoke_writes_through_views.sql
-- SECURITY: visitors could write through the public views. Take every write privilege on every view
-- in schema public away from anon and authenticated; reading is unchanged.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHY. Supabase's default privileges grant ALL on every new table AND view in public to anon and
-- authenticated. For a table that is harmless, because row-level security decides what each caller
-- may touch. A view is different: a simple view is automatically updatable, and one that runs with
-- its owner's rights (security_invoker unset or false, as investigators_public, public_jobs,
-- feature_suggestions_public and investigator_directory do on purpose, to show a sanitized subset
-- of a hidden table) passes an UPDATE, INSERT or DELETE straight through to the base table as the
-- owner, which row-level security does not stop. On a replica of this schema (2026-11-17):
--     SET ROLE anon;  UPDATE public.public_jobs SET title = '...' WHERE id = ...;                 -- UPDATE 1
--     SET ROLE anon;  UPDATE public.feature_suggestions_public SET title = '...' WHERE id = ...;  -- UPDATE 1
-- and the rows in jobs and feature_suggestions changed. authenticated held the same rights on
-- investigators_public and investigator_directory, i.e. any signed-in user could rewrite another
-- person's public profile fields.
--
-- WHAT. For every view in schema public: REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER,
-- REFERENCES from anon, authenticated and PUBLIC. SELECT stays exactly as granted, so every page
-- that reads a view keeps working. Nothing in src/ or supabase/functions writes through a view
-- (checked 2026-11-17); edge functions run as service_role, which this does not touch. Views created
-- later must revoke the same rights themselves: tests/guards/view-write-privileges holds every
-- migration after this one to that.
--
-- CHECK FIRST (read-only; shows which views visitors could write through today):
--   SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
--     FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
--      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
--      AND table_name IN (SELECT table_name FROM information_schema.views WHERE table_schema = 'public')
--    GROUP BY 1, 2 ORDER BY 1, 2;
--
-- HOW TO APPLY: Supabase SQL editor, project vpexxhfpvghlejljwpvt, as its default role (postgres).
-- Paste the WHOLE file, Run. One transaction; a second run changes nothing. The last statement lists
-- each view with what anon and authenticated may still do (SELECT only, where they could before).
-- UNDO (do not, unless a client is found that must write through a view): GRANT the privilege back on
-- that one view, e.g. GRANT UPDATE ON public.<view> TO authenticated.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS pg_temp.kg_view_writes_before;

BEGIN;
SELECT public.set_actor('migration:revoke_writes_through_views');

CREATE TEMP TABLE kg_view_writes_before AS
SELECT g.table_name::text AS view_name, g.grantee::text AS grantee,
       string_agg(g.privilege_type::text, ', ' ORDER BY g.privilege_type::text) AS could_write
  FROM information_schema.role_table_grants g
 WHERE g.table_schema = 'public' AND g.grantee IN ('anon', 'authenticated', 'PUBLIC')
   AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')
   AND g.table_name IN (SELECT v.table_name FROM information_schema.views v WHERE v.table_schema = 'public')
 GROUP BY 1, 2;

DO $revoke$
DECLARE _v regclass;
BEGIN
  FOR _v IN
    SELECT c.oid::regclass
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON %s FROM anon, authenticated, PUBLIC', _v);
  END LOOP;
END
$revoke$;

COMMIT;

-- The report (the editor shows only this last result): per view, what anon and authenticated could
-- write before this run, and what they may do now.
SELECT v.table_name AS view_name,
       coalesce((SELECT string_agg(b.grantee || ': ' || b.could_write, '; ' ORDER BY b.grantee)
                   FROM pg_temp.kg_view_writes_before b WHERE b.view_name = v.table_name), 'none') AS could_write_before,
       coalesce((SELECT string_agg(DISTINCT g.grantee || ' ' || g.privilege_type, ', ')
                   FROM information_schema.role_table_grants g
                  WHERE g.table_schema = 'public' AND g.table_name = v.table_name
                    AND g.grantee IN ('anon', 'authenticated', 'PUBLIC')), 'nothing') AS may_now,
       v.is_updatable AS updatable_view
  FROM information_schema.views v
 WHERE v.table_schema = 'public'
 ORDER BY (SELECT count(*) FROM pg_temp.kg_view_writes_before b WHERE b.view_name = v.table_name) DESC, v.table_name;
