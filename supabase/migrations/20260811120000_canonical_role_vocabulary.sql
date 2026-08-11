-- One canonical role vocabulary per column, enforced (issue #283, tasks T-D1c/T-D1d/T-D1e).
--
-- TWO COLUMNS, TWO JOBS. They are not interchangeable and must stop being treated as such:
--
--   grant_investigators.role  per-grant, RePORTER-derived. THE authority for "role on this project".
--                             Canonical tokens only.
--   investigators.role        one free-text consortium/career label. Its own UI placeholder reads
--                             "e.g. Working Group Chair, Trainee, Steering Committee". A scalar
--                             cannot express a role that varies per grant, so it is NOT a project
--                             role and must never carry a machine token.
--
-- MEASURED DRIFT (2026-08-11):
--   investigators.role       38 "Principal Investigator (PI)", 32 "Postdoc/Grad Student",
--                            27 "Research Staff (Scientist and others)", 68 NULL, and 22 MACHINE
--                            TOKENS (contact_pi 5, co_pi 4, postdoc 7, co-investigator 2,
--                            research_staff 1, nih_program 1, project_manager 1, "Grad Student" 1)
--                            written by onboard_member and the agent's onboarding workflow.
--   grant_investigators.role canonical, plus leaked "staff" (3), "trainee" (1), "Grad Student" (1).
--
-- WHY IT MATTERED: sync-member-groups decided pi@ by exact-matching investigators.role. 74
-- investigators hold a PI role on the roster; 9 had a canonical token in investigators.role. The
-- trigger missed 65 real PIs, and the 9 it caught were exactly those a wizard had written a token
-- for. group-audit derives the expected pi@ set FROM the roster, so the two surfaces disagreed and
-- the audit reported drift no repair could settle. Fixed in cf10b70.
--
-- ── THE ORDERING HAZARD, AND WHY THIS MIGRATION IS SAFE WITHOUT THE DEPLOY ──────────────────────
-- trg_sync_member_groups fires AFTER UPDATE on investigators.role and posts to sync-member-groups,
-- which adds and REMOVES Google Group memberships. Re-labelling contact_pi -> "Principal
-- Investigator (PI)" under the OLD function would compute "no longer a PI" and remove those 9 people
-- from pi@ — a data normalization causing outward-facing damage.
--
-- Rather than depend on the fixed function being deployed first, the backfill runs with that trigger
-- DISABLED. A normalization of stored vocabulary is not a membership change and must not emit one,
-- whichever version is live. Group state is then reconciled deliberately, by a human, via the
-- console's group audit — which is roster-derived and therefore already correct.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260811120000');

-- ── T-D1c · canonicalize grant_investigators.role, and keep it that way ────────────────────────
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
  'Canonicalizes a grant_investigators.role token. Unknown values pass through unchanged rather than being coerced -- a wrong role is worse than an unrecognized one.';

CREATE OR REPLACE FUNCTION public.normalize_grant_role_trg()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.role := public.normalize_grant_role(NEW.role);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_normalize_grant_role ON public.grant_investigators;
CREATE TRIGGER trg_normalize_grant_role
  BEFORE INSERT OR UPDATE ON public.grant_investigators
  FOR EACH ROW EXECUTE FUNCTION public.normalize_grant_role_trg();

-- Backfill. Safe to let triggers fire here: grant_investigators has no group-sync trigger, only the
-- audit trigger, and an audit row for this change is exactly what we want.
UPDATE public.grant_investigators
   SET role = public.normalize_grant_role(role)
 WHERE role IS DISTINCT FROM public.normalize_grant_role(role);

-- ── T-D1d · clear machine tokens out of investigators.role ─────────────────────────────────────
-- Map each canonical token to the HUMAN label the Google Form already uses, so the column ends up
-- with one vocabulary instead of two. Mapping to the dominant existing label (rather than to NULL)
-- keeps career-stage classification working: young-investigators@ and the group audit both match
-- these labels by substring.
CREATE OR REPLACE FUNCTION public.role_label_from_token(_role text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE lower(btrim(coalesce(_role, '')))
    WHEN 'pi'               then 'Principal Investigator (PI)'
    WHEN 'contact_pi'       then 'Principal Investigator (PI)'
    WHEN 'co_pi'            then 'Principal Investigator (PI)'
    WHEN 'mpi'              then 'Principal Investigator (PI)'
    WHEN 'co-investigator'  then 'Co-Investigator'
    WHEN 'co_investigator'  then 'Co-Investigator'
    WHEN 'postdoc'          then 'Postdoc/Grad Student'
    WHEN 'graduate_student' then 'Postdoc/Grad Student'
    WHEN 'grad_student'     then 'Postdoc/Grad Student'
    WHEN 'grad student'     then 'Postdoc/Grad Student'
    WHEN 'research_staff'   then 'Research Staff (Scientist and others)'
    WHEN 'data_manager'     then 'Data Manager'
    WHEN 'project_manager'  then 'Project Manager'
    WHEN 'nih_program'      then 'NIH Program'
    ELSE NULL                          -- not a machine token: leave the free text alone
  END
$fn$;

COMMENT ON FUNCTION public.role_label_from_token(text) IS
  'Human label for a canonical role token, for cleaning machine tokens out of the free-text investigators.role. Returns NULL for anything that is not a token, so genuine free text is never rewritten.';

DO $do$
DECLARE _n int;
BEGIN
  -- DISABLE the group-sync trigger for the backfill. See the ordering hazard above: under the
  -- pre-cf10b70 function this UPDATE would have removed 9 PIs from pi@. A vocabulary normalization
  -- must not emit membership changes regardless of which function version is deployed.
  ALTER TABLE public.investigators DISABLE TRIGGER trg_sync_member_groups;

  UPDATE public.investigators
     SET role = public.role_label_from_token(role)
   WHERE public.role_label_from_token(role) IS NOT NULL
     AND role IS DISTINCT FROM public.role_label_from_token(role);
  GET DIAGNOSTICS _n = ROW_COUNT;
  RAISE NOTICE 'investigators.role: % machine tokens replaced with their human label', _n;

  ALTER TABLE public.investigators ENABLE TRIGGER trg_sync_member_groups;
END
$do$;

-- ── T-D1e · onboard_member stops writing the roster token into investigators.role ──────────────
-- The wizard's role field is a PROJECT role: it belongs in grant_investigators.role, which the RPC
-- already sets. Writing it to investigators.role as well is what put contact_pi/co_pi on five
-- profiles and made the project tab and the profile disagree. Write the human LABEL there instead,
-- and only when the column is empty -- an existing value may be a curated service role
-- ("Working Group Chair") that an onboard has no business overwriting.

-- Full re-declaration: Postgres cannot patch a function body, so onboard_member is restated from
-- 20260810130000 with exactly two changes -- both assignments to investigators.role now write the
-- human LABEL instead of the canonical token, and the UPDATE path only fills an EMPTY value.
-- grant_investigators.role (further down, unchanged) keeps the canonical token: that is the
-- authoritative project role.
CREATE OR REPLACE FUNCTION public.onboard_member(
  _email text, _name text, _role text DEFAULT 'research_staff',
  _working_groups text[] DEFAULT '{}', _pending_role text DEFAULT NULL,
  _institution text DEFAULT NULL, _grant_id uuid DEFAULT NULL,
  _secondary_emails text[] DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _email_n text := lower(trim(_email));
  _role_n text := lower(trim(coalesce(_role, '')));
  _pending app_role;
  _inv_id uuid; _existing jsonb; _seed jsonb; _merged jsonb;
  _is_pi boolean; _is_trainee boolean; _grant_linked boolean := false;
  _sec text[] := coalesce(_secondary_emails, '{}');
  _name_n text;
  _stub_id uuid;
  _reconciled text := NULL;   -- 'adopted_stub' | 'merged_stub' | NULL
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can onboard members';
  END IF;
  IF _email_n = '' OR _email_n !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'A valid email is required';
  END IF;
  IF coalesce(trim(_name), '') = '' THEN RAISE EXCEPTION 'A name is required'; END IF;

  _role_n := CASE _role_n
    WHEN 'pi' THEN 'PI' WHEN 'contact_pi' THEN 'contact_pi' WHEN 'co_pi' THEN 'co_pi'
    WHEN 'mpi' THEN 'mpi' WHEN 'co-investigator' THEN 'co-investigator' WHEN 'co_investigator' THEN 'co-investigator'
    WHEN 'postdoc' THEN 'postdoc' WHEN 'graduate_student' THEN 'graduate_student' WHEN 'grad_student' THEN 'graduate_student'
    WHEN 'research_staff' THEN 'research_staff' WHEN 'data_manager' THEN 'data_manager' WHEN 'project_manager' THEN 'project_manager'
    WHEN 'nih_program' THEN 'nih_program' WHEN 'admin' THEN 'admin' WHEN 'other' THEN 'other'
    ELSE 'research_staff' END;
  _is_pi := _role_n IN ('PI', 'contact_pi', 'co_pi', 'mpi', 'co-investigator');
  _is_trainee := _role_n IN ('postdoc', 'graduate_student');
  _pending := CASE lower(coalesce(_pending_role, ''))
    WHEN 'admin' THEN 'admin'::app_role WHEN 'curator' THEN 'curator'::app_role ELSE NULL END;

  IF _grant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.grants WHERE id = _grant_id) THEN
    RAISE EXCEPTION 'Grant % not found', _grant_id;
  END IF;

  SELECT id, onboarding_checklist INTO _inv_id, _existing
    FROM public.investigators WHERE lower(email) = _email_n LIMIT 1;

  -- Find an email-less twin of this person (a RePORTER import stub). Whitespace runs are collapsed
  -- and case is folded, because that is exactly how the stubs differ from a hand-typed name.
  -- Prefer the candidate carrying grant-roster rows, then the oldest: those are the rows other
  -- tables already point at, so adopting them preserves history instead of orphaning it.
  _name_n := lower(regexp_replace(btrim(_name), '[[:space:]]+', ' ', 'g'));
  SELECT i.id INTO _stub_id
    FROM public.investigators i
   WHERE (i.email IS NULL OR btrim(i.email) = '')
     AND lower(regexp_replace(btrim(i.name), '[[:space:]]+', ' ', 'g')) = _name_n
     AND (_inv_id IS NULL OR i.id <> _inv_id)
   ORDER BY (SELECT count(*) FROM public.grant_investigators g WHERE g.investigator_id = i.id) DESC,
            i.created_at ASC
   LIMIT 1;

  IF _inv_id IS NULL AND _stub_id IS NOT NULL THEN
    -- ADOPT: this person is already in the table without an email. Claim that row.
    _inv_id := _stub_id;
    _reconciled := 'adopted_stub';
    SELECT onboarding_checklist INTO _existing FROM public.investigators WHERE id = _inv_id;
    -- A welcome cannot have been delivered to a record that had no address.
    _existing := coalesce(_existing, '{}'::jsonb) - 'welcome_email';

  ELSIF _inv_id IS NOT NULL AND _stub_id IS NOT NULL THEN
    -- MERGE: repoint every referencing row onto the emailed keeper, skipping pairs it already has
    -- (each target has a composite unique key, so a blind UPDATE would collide). Anything left
    -- behind is removed by the CASCADE on the DELETE below.
    UPDATE public.grant_investigators gi SET investigator_id = _inv_id
     WHERE gi.investigator_id = _stub_id
       AND NOT EXISTS (SELECT 1 FROM public.grant_investigators k
                        WHERE k.investigator_id = _inv_id AND k.grant_id = gi.grant_id);
    UPDATE public.investigator_organizations io SET investigator_id = _inv_id
     WHERE io.investigator_id = _stub_id
       AND NOT EXISTS (SELECT 1 FROM public.investigator_organizations k
                        WHERE k.investigator_id = _inv_id AND k.organization_id = io.organization_id);
    UPDATE public.personality_scores ps SET investigator_id = _inv_id
     WHERE ps.investigator_id = _stub_id
       AND NOT EXISTS (SELECT 1 FROM public.personality_scores k WHERE k.investigator_id = _inv_id);

    DELETE FROM public.investigators WHERE id = _stub_id;   -- before any rename (23505 guard)
    _reconciled := 'merged_stub';
  END IF;

  IF _inv_id IS NULL THEN
    INSERT INTO public.investigators (name, email, role, working_groups, pending_role, institution, secondary_emails)
    VALUES (trim(_name), _email_n, public.role_label_from_token(_role_n), _working_groups, _pending, nullif(trim(_institution), ''),
            CASE WHEN array_length(_sec, 1) > 0 THEN _sec ELSE NULL END)
    RETURNING id INTO _inv_id;
  ELSE
    UPDATE public.investigators SET
      name = coalesce(nullif(trim(_name), ''), name),
      email = _email_n,                      -- required on the ADOPT path; a no-op when matched by email
      -- PROJECT role belongs in grant_investigators (set below), NOT here. This column is a
      -- free-text consortium/career label, and writing the token put contact_pi/co_pi on five
      -- profiles (issue #283). Fill it only when EMPTY: an existing value may be a curated
      -- service role like "Working Group Chair" that an onboard must not overwrite.
      role = coalesce(nullif(btrim(role), ''), public.role_label_from_token(_role_n)),
      working_groups = _working_groups,
      pending_role = coalesce(_pending, pending_role),
      institution = coalesce(nullif(trim(_institution), ''), institution),
      secondary_emails = CASE WHEN array_length(_sec, 1) > 0 THEN _sec ELSE secondary_emails END
    WHERE id = _inv_id;
  END IF;

  IF _grant_id IS NOT NULL THEN
    INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
    VALUES (_grant_id, _inv_id, _role_n) ON CONFLICT DO NOTHING;
    _grant_linked := true;
  END IF;

  -- Base steps for everyone. data_questionnaire is added ONLY for PI roles (fix P6-A).
  _seed := jsonb_build_object('pre_check','done','kg_created','done','consortium_group','done',
                              'welcome_email','not_started','slack','not_started');
  IF public.role_owns_questionnaire(_role_n) THEN
    _seed := _seed || jsonb_build_object('data_questionnaire', 'not_started');
  END IF;
  IF _is_pi THEN _seed := _seed || jsonb_build_object('pi_group', 'done'); END IF;
  IF _is_trainee THEN _seed := _seed || jsonb_build_object('young_investigators_group', 'done'); END IF;
  IF coalesce(array_length(_working_groups, 1), 0) > 0 THEN _seed := _seed || jsonb_build_object('wg_groups', 'done'); END IF;
  IF _grant_linked THEN _seed := _seed || jsonb_build_object('grant_link', 'done');
  ELSIF _is_pi THEN _seed := _seed || jsonb_build_object('grant_link', 'not_started'); END IF;

  -- An adopted stub may already carry a grant roster row even when the wizard passed no grant.
  IF NOT _grant_linked AND EXISTS (
    SELECT 1 FROM public.grant_investigators g WHERE g.investigator_id = _inv_id
  ) THEN
    _seed := _seed || jsonb_build_object('grant_link', 'done');
    _grant_linked := true;
  END IF;

  _existing := coalesce(_existing, '{}'::jsonb) - 'status' - 'offboarded_at';
  IF NOT public.role_owns_questionnaire(_role_n) THEN _existing := _existing - 'data_questionnaire'; END IF;

  SELECT coalesce(jsonb_object_agg(k, val), '{}'::jsonb) INTO _merged
  FROM (
    SELECT k, CASE WHEN (_existing ? k) AND public.onboarding_status_rank(_existing ->> k) >= public.onboarding_status_rank(_seed ->> k)
                   THEN _existing -> k ELSE _seed -> k END AS val
    FROM (SELECT jsonb_object_keys(_existing) AS k UNION SELECT jsonb_object_keys(_seed) AS k) keys
  ) m;

  UPDATE public.investigators SET onboarding_checklist = _merged, onboarding_completed_at = NULL WHERE id = _inv_id;

  RETURN jsonb_build_object('ok', true, 'investigator_id', _inv_id, 'email', _email_n,
                            'role', _role_n, 'grant_linked', _grant_linked,
                            'reconciled', _reconciled, 'checklist', _merged);
END;
$$;

GRANT EXECUTE ON FUNCTION public.onboard_member(text, text, text, text[], text, text, uuid, text[]) TO authenticated;

GRANT EXECUTE ON FUNCTION public.normalize_grant_role(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.role_label_from_token(text) TO authenticated, service_role;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) grant_investigators.role: expect ONLY canonical tokens (plus the deliberate 'trainee').
SELECT role, count(*) AS n
  FROM public.grant_investigators
 GROUP BY 1 ORDER BY 2 DESC;

-- 2) investigators.role: expect ZERO machine tokens.
SELECT role, count(*) AS n
  FROM public.investigators
 WHERE public.role_label_from_token(role) IS NOT NULL
   AND role = lower(role)                 -- a token is lowercase; the labels are not
 GROUP BY 1 ORDER BY 2 DESC;

-- 3) The trigger is back on. Expect one row, tgenabled = 'O'.
SELECT tgname, tgenabled
  FROM pg_trigger
 WHERE tgrelid = 'public.investigators'::regclass
   AND tgname = 'trg_sync_member_groups';

-- 4) Roster vs label agreement for PI-ness — the number that started this. Expect pi_by_roster
--    unchanged at 74; pi_by_label now 0, because pi@ no longer comes from the label at all.
SELECT (SELECT count(DISTINCT investigator_id) FROM public.grant_investigators
         WHERE lower(role) IN ('pi','contact_pi','co_pi','mpi')) AS pi_by_roster,
       (SELECT count(*) FROM public.investigators
         WHERE lower(btrim(coalesce(role,''))) IN ('pi','contact_pi','co_pi','mpi')) AS pi_by_label;
