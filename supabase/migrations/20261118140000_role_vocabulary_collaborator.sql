-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261118140000_role_vocabulary_collaborator.sql
-- 'collaborator' is a project role: teach normalize_grant_role the token the roster screens offer.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHY. grant_investigators.role holds canonical tokens only (issue #283): normalize_grant_role,
-- behind trg_normalize_grant_role, maps what it recognises and passes anything else through
-- unchanged. The roster editor (TeamRosterEditor) and the person summary have always offered
-- "Collaborator", but the function never listed it. Between the exports of 2026-11-17 and
-- 2026-11-18 a curator chose it for one role on U24DA064429; it was stored as an unknown token, and
-- the graph's rule #4 (ProjectRoleTokenShape) reported an error no data fix could clear. The owner
-- decided on 2026-11-18 that 'collaborator' is a valid project role.
--
-- WHAT.
--   1. normalize_grant_role gains  WHEN 'collaborator' THEN 'collaborator'  and is otherwise the
--      20260811120000 definition, word for word. It is replaced only if the live function IS that
--      definition (or already this one): any other body stops the script with nothing changed, so
--      a hand edit made since is never overwritten.
--   2. Who may run it is stated (tests/guards/function-execute-grants): signed-in users and the
--      service role, because the trigger runs it as whoever writes the roster; not anon.
--   3. A roster row whose role is 'collaborator' in another case or with spaces is rewritten to the
--      token. The row a curator chose already holds the token, so 0 rows are expected.
--   The KG schema's project_role_enum and shape #4 gain the token in the same commit
--   (tests/guards/kg-role-vocabulary-parity holds them equal to this function), and
--   tests/guards/role-ui-vocabulary now holds every role menu to the function.
--   Not changed: role_label_from_token. It maps a token to the Google Form's label for the free-text
--   investigators.role, and the form has no "Collaborator" option; the screens already show
--   "Collaborator" for the token.
--
-- HOW TO APPLY: Supabase SQL editor, project vpexxhfpvghlejljwpvt, as its default role (postgres).
-- Paste the WHOLE file, Run. One transaction; a second run changes nothing. The last statement lists
-- every role value on the roster with its count and whether the vocabulary knows it.
-- UNDO: re-apply the function from 20260811120000_canonical_role_vocabulary.sql. Rows rewritten by
-- step 3 are in data_audit_log under 'migration:role_vocabulary_collaborator'.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT public.set_actor('migration:role_vocabulary_collaborator');
SELECT public.set_source_class('curator_fill');

-- The live function must be the one this script knows: the 20260811120000 definition, or this
-- script's own (a second run). Compared on the body with whitespace folded, so line endings do not
-- matter.
DO $guard$
DECLARE
  _n   int;
  _md5 text;
BEGIN
  SELECT count(*) INTO _n FROM pg_proc p
   WHERE p.proname = 'normalize_grant_role' AND p.pronamespace = 'public'::regnamespace;
  IF _n = 0 THEN
    RAISE EXCEPTION 'public.normalize_grant_role does not exist: apply 20260811120000_canonical_role_vocabulary first. NOTHING WAS CHANGED.';
  ELSIF _n > 1 THEN
    RAISE EXCEPTION 'public.normalize_grant_role has % definitions (expected 1). NOTHING WAS CHANGED.', _n;
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) INTO _md5 FROM pg_proc p
   WHERE p.oid = 'public.normalize_grant_role(text)'::regprocedure;
  IF _md5 NOT IN ('72be7ed16dc86fc299a8dc76042a7f1f',      -- 20260811120000
                  '4f23877eb19877d9b8ec9581c3c74640') THEN -- this script, on a second run
    RAISE EXCEPTION 'public.normalize_grant_role is not the 20260811120000 definition (body fingerprint %). It was changed by hand, so it is not replaced. NOTHING WAS CHANGED. Send its definition: SELECT pg_get_functiondef(''public.normalize_grant_role(text)''::regprocedure);', _md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.normalize_grant_role(_role text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE lower(btrim(coalesce(_role, '')))
    WHEN 'pi'                then 'PI'
    WHEN 'contact_pi'        then 'contact_pi'
    WHEN 'contact pi'        then 'contact_pi'
    WHEN 'co_pi'             then 'co_pi'
    WHEN 'co-pi'             then 'co_pi'
    WHEN 'mpi'               then 'mpi'
    WHEN 'co-investigator'   then 'co-investigator'
    WHEN 'co_investigator'   then 'co-investigator'
    WHEN 'collaborator'      then 'collaborator'       -- offered by the roster screens; a role since 2026-11-18
    WHEN 'postdoc'           then 'postdoc'
    WHEN 'post-doc'          then 'postdoc'
    WHEN 'graduate_student'  then 'graduate_student'
    WHEN 'grad_student'      then 'graduate_student'
    WHEN 'grad student'      then 'graduate_student'   -- leaked form label, 1 row
    WHEN 'staff'             then 'research_staff'     -- leaked, 3 rows
    WHEN 'research_staff'    then 'research_staff'
    WHEN 'data_manager'      then 'data_manager'
    WHEN 'project_manager'   then 'project_manager'
    WHEN 'nih_program'       then 'nih_program'
    WHEN 'admin'             then 'admin'
    WHEN 'other'             then 'other'
    -- 'trainee' (1 row) is deliberately PASSED THROUGH, not mapped: it could mean postdoc or
    -- graduate_student and guessing would assert a career stage nobody stated. isYoungInvestigator
    -- already matches it by substring, so it entitles correctly as-is.
    ELSE nullif(btrim(coalesce(_role, '')), '')
  END
$fn$;

COMMENT ON FUNCTION public.normalize_grant_role(text) IS
  'Canonicalizes a grant_investigators.role token. Unknown values pass through unchanged rather than being coerced -- a wrong role is worse than an unrecognized one. Every value a role menu offers must be listed here (tests/guards/role-ui-vocabulary).';

-- Who may run it: the trigger trg_normalize_grant_role runs it as whoever writes the roster
-- (signed-in curators and members' own edits, the service role). A visitor never writes the roster.
REVOKE ALL ON FUNCTION public.normalize_grant_role(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_grant_role(text) TO authenticated, service_role;

-- The function must do what this script says before any row is touched.
DO $selftest$
BEGIN
  IF public.normalize_grant_role(' Collaborator ') IS DISTINCT FROM 'collaborator'
     OR public.normalize_grant_role('pi') IS DISTINCT FROM 'PI'
     OR public.normalize_grant_role('staff') IS DISTINCT FROM 'research_staff'
     OR public.normalize_grant_role('trainee') IS DISTINCT FROM 'trainee'
     OR public.normalize_grant_role('Something Else') IS DISTINCT FROM 'Something Else'
     OR public.normalize_grant_role('  ') IS NOT NULL THEN
    RAISE EXCEPTION 'normalize_grant_role does not behave as 20261118140000 expects. NOTHING WAS CHANGED.';
  END IF;
END
$selftest$;

-- Rows that hold the role in another spelling take the token (0 expected).
UPDATE public.grant_investigators
   SET role = public.normalize_grant_role(role)
 WHERE role IS DISTINCT FROM public.normalize_grant_role(role);

COMMIT;

-- The report (the editor shows only this last result): every role on the roster, the ones the
-- vocabulary does not know first.
SELECT r.role, r.roster_rows, r.status,
       (SELECT count(*) FROM public.data_audit_log d
         WHERE d.actor_label = 'migration:role_vocabulary_collaborator' AND d.table_name = 'grant_investigators') AS rows_this_script_has_rewritten
  FROM (SELECT gi.role,
               count(*) AS roster_rows,
               CASE WHEN gi.role IS NULL THEN 'no role recorded'
                    WHEN gi.role IN ('PI', 'contact_pi', 'co_pi', 'mpi', 'co-investigator', 'collaborator', 'trainee', 'postdoc',
                                     'graduate_student', 'research_staff', 'data_manager', 'project_manager', 'nih_program',
                                     'admin', 'other') THEN 'in the vocabulary'
                    ELSE 'NOT in the vocabulary: a curator picks a role for these rows'
               END AS status
          FROM public.grant_investigators gi
         GROUP BY gi.role) r
 ORDER BY (r.status = 'in the vocabulary'), r.roster_rows DESC, r.role;
