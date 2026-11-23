-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261118100000_hotfix_anon_function_grants.sql
-- SECURITY HOTFIX: an anonymous visitor could add an e-mail address to any member's record, and the
-- sign-in then treats that address as the member. Stop anonymous callers running that function and
-- the few like it. Nothing else changes.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHY. PostgreSQL lets everyone (PUBLIC) execute a new function, and Supabase's default privileges
-- grant EXECUTE to anon as well. A migration that says GRANT EXECUTE ... TO authenticated,
-- service_role adds to that; it takes nothing away. So every function in schema public that never
-- says REVOKE is callable through the API with the site's public key.
--   * record_investigator_alias(primary_email, alias) is SECURITY DEFINER and gates on
--     "auth.uid() IS NOT NULL AND not admin/curator". An anonymous caller has no auth.uid(), exactly
--     like the service role the gate means to let through, so the gate passes and the alias is
--     appended to that member's secondary_emails. globus-auth resolves a signing-in address found in
--     secondary_emails to that member's primary address and signs the caller in as that member
--     (supabase/functions/globus-auth/index.ts, "Resolved secondary email"). On a replica of this
--     schema, 2026-11-18:  SET ROLE anon;  SELECT public.record_investigator_alias(<member's
--     address>, <another address>);  ->  {"ok": true, ...}, and the row changed.
--   * check_onboard_conflicts(email, name) has the same gate and returns the member records a name
--     collides with, e-mail addresses included: it gives an anonymous caller the address the call
--     above needs.
--   * provenance_attach_all / _attach_guard / _attach_recorder / _detach_out_of_scope create and
--     drop triggers, and provenance_backfill_all / _backfill_unknown write provenance claims, with no
--     check of the caller at all. Only migrations call them.
--
-- WHAT. For exactly those eight function names (every overload found): REVOKE EXECUTE FROM PUBLIC
-- and anon. The two that signed-in curators and the service role really call get an explicit GRANT
-- back to authenticated and service_role, so nothing they do changes:
--     record_investigator_alias   <- group-audit (service role)
--     check_onboard_conflicts     <- OnboardMemberDialog (curators; the function checks the role)
-- The six provenance maintenance functions are granted to service_role only (migrations run as the
-- owner, which always may). No function body, table, row or policy is touched. No site page and no
-- edge function calls any of these as an anonymous visitor (checked on main, dev and this branch).
-- The complete review of what anon and signed-in users may execute is
-- 20261118120000_privacy_round_two; this hotfix is the part that cannot wait for it.
--
-- CHECK WHETHER IT WAS USED (read-only; run it before or after, the audit trail is not changed):
--   SELECT d.occurred_at, i.name, d.actor_role, d.actor_label, d.actor_id,
--          d.changed_fields -> 'secondary_emails' AS secondary_emails_change
--     FROM public.data_audit_log d
--     LEFT JOIN public.investigators i ON i.id::text = d.record_id
--    WHERE d.table_name = 'investigators' AND d.changed_fields ? 'secondary_emails'
--    ORDER BY d.occurred_at DESC;
-- Every row is one change to someone's alias list. Expected: actor_role service_role (group-audit),
-- or a curator/admin, or a migration label. A row with actor_role 'anon' is the hole being used:
-- remove that address from the member's secondary_emails and tell the member.
--
-- HOW TO APPLY: Supabase SQL editor, project vpexxhfpvghlejljwpvt, as its default role (postgres).
-- Paste the WHOLE file, Run. One transaction; a second run changes nothing. The last statement lists
-- each function with whether anon could run it before and can now (must be false for all).
-- UNDO (do not): GRANT EXECUTE ON FUNCTION public.<name>(<args>) TO anon.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS pg_temp.kg_hotfix_fn;

BEGIN;
SELECT public.set_actor('migration:hotfix_anon_function_grants');

CREATE TEMP TABLE kg_hotfix_fn AS
SELECT p.oid, p.oid::regprocedure::text AS fn, w.keep_authenticated,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_before,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_before
  FROM (VALUES ('record_investigator_alias', true), ('check_onboard_conflicts', true),
               ('provenance_attach_all', false), ('provenance_attach_guard', false),
               ('provenance_attach_recorder', false), ('provenance_detach_out_of_scope', false),
               ('provenance_backfill_all', false), ('provenance_backfill_unknown', false)
       ) AS w(fn_name, keep_authenticated)
  JOIN pg_proc p ON p.proname = w.fn_name AND p.pronamespace = 'public'::regnamespace;

DO $hotfix$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_temp.kg_hotfix_fn LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.fn);
    IF r.keep_authenticated THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.fn);
    END IF;
  END LOOP;
END
$hotfix$;

COMMIT;

-- The report (the editor shows only this last result). anon_can_run_now must be false in every row.
SELECT h.fn AS function,
       h.anon_before AS anon_could_run,
       has_function_privilege('anon', h.oid, 'EXECUTE') AS anon_can_run_now,
       h.authenticated_before AS signed_in_could_run,
       has_function_privilege('authenticated', h.oid, 'EXECUTE') AS signed_in_can_run_now,
       has_function_privilege('service_role', h.oid, 'EXECUTE') AS service_role_can_run_now
  FROM pg_temp.kg_hotfix_fn h
UNION ALL
SELECT w.fn_name || ' (no function of this name in this database)', NULL, NULL, NULL, NULL, NULL
  FROM (VALUES ('record_investigator_alias'), ('check_onboard_conflicts'), ('provenance_attach_all'),
               ('provenance_attach_guard'), ('provenance_attach_recorder'), ('provenance_detach_out_of_scope'),
               ('provenance_backfill_all'), ('provenance_backfill_unknown')) AS w(fn_name)
 WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = w.fn_name AND p.pronamespace = 'public'::regnamespace)
 ORDER BY 1;
