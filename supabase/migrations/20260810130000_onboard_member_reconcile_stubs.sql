-- onboard_member must RECONCILE with NIH RePORTER import stubs, not duplicate the person.
--
-- GROUND TRUTH (2026-08-10, KG vpexxhfpvghlejljwpvt). Importing a grant from RePORTER creates
-- `investigators` rows that carry only a NAME — frequently with a doubled space, e.g.
-- "Firooz  Aflatouni" — plus the `grant_investigators` roster row with the correct PI role.
-- 24 such email-less records currently hold roster rows, so this is a CLASS, not a one-off.
--
-- `onboard_member` upserts BY EMAIL (`lower(email) = _email_n`). Those stubs have `email IS NULL`,
-- so onboarding one of them from the admin console does one of two wrong things:
--   * INSERTs a SECOND person, when the typed name differs from the stub by whitespace or case.
--     The roster row stays attached to the stub, so the new record shows `live_grant_count = 0`
--     and the pipeline reports "PI needs a grant" forever, while the stub sits on the grant.
--   * FAILS with 23505 on `investigators_name_key`, when the typed name matches the stub exactly.
-- Both paths were confirmed against grant 1U01MH144347-01 (SMART-DBS), whose five PIs are all
-- email-less stubs. Two name-collision pairs already exist in the table from earlier rounds of
-- this same bug: "Bijan  Pesaran" vs "Bijan Pesaran", "JACK  GRINBAND" vs "Jack Grinband".
--
-- FIX. Before inserting, look for an EMAIL-LESS record whose whitespace/case-normalized name
-- equals the typed name:
--   ADOPT — no email match exists: claim that stub (it already carries the roster rows) and set
--           its email, instead of inserting a twin alongside it.
--   MERGE — an email match AND a separate stub both exist: repoint the stub's referencing rows
--           onto the emailed record, DELETE the stub, and only THEN rename the keeper.
--
-- Two ordering constraints, both learned the hard way:
--   1. Every FK to `investigators.id` is ON DELETE CASCADE (`grant_investigators`,
--      `investigator_organizations`, `personality_scores` — the complete list per pg_constraint).
--      Repointing MUST precede the DELETE, or the grant roster row vanishes with the stub.
--   2. merge -> delete -> rename. Renaming the keeper before deleting the stub trips
--      `investigators_name_key` (23505) — the failure mode hit twice on 2026-08-07.
--
-- Adoption also DROPS an inherited `welcome_email: 'done'`. The 19 records the legacy backfill
-- marked complete have no email address at all, so no welcome can have reached them; keeping the
-- claim would hide a real outstanding step behind a false "done".
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

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
    VALUES (trim(_name), _email_n, _role_n, _working_groups, _pending, nullif(trim(_institution), ''),
            CASE WHEN array_length(_sec, 1) > 0 THEN _sec ELSE NULL END)
    RETURNING id INTO _inv_id;
  ELSE
    UPDATE public.investigators SET
      name = coalesce(nullif(trim(_name), ''), name),
      email = _email_n,                      -- required on the ADOPT path; a no-op when matched by email
      role = _role_n,
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
