-- Anon and signed-in callers could write a provenance claim at any grade on any cell (a verified
-- grade then makes enforce_field_provenance refuse later machine updates of that cell), and move any
-- suggestion's vote count with triggers off. The only callers are migrations and two SECURITY
-- DEFINER functions (confirm_species_candidate, provenance_mark_verified), which run as the owner.
-- This is the function-grant part of 20261118120000_privacy_round_two (#520), ahead of its column
-- changes; re-running either is harmless.
BEGIN;
SELECT public.set_actor('migration:20261119150000_revoke_open_writer_functions');

REVOKE EXECUTE ON FUNCTION public.record_field_provenance(text, uuid, text, text, text, text, text, text, text, text, numeric, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_field_provenance(text, uuid, text, text, text, text, text, text, text, text, numeric, timestamptz, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.increment_vote_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_vote_count(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.decrement_vote_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decrement_vote_count(uuid) TO service_role;

SELECT p.oid::regprocedure AS function,
       has_function_privilege('anon', p.oid, 'execute')          AS anon,
       has_function_privilege('authenticated', p.oid, 'execute') AS authenticated,
       has_function_privilege('service_role', p.oid, 'execute')  AS service_role
  FROM pg_proc p
 WHERE p.oid IN ('public.record_field_provenance(text, uuid, text, text, text, text, text, text, text, text, numeric, timestamptz, text)'::regprocedure,
                 'public.increment_vote_count(uuid)'::regprocedure,
                 'public.decrement_vote_count(uuid)'::regprocedure);
COMMIT;
