-- Two fixes (P6):
--  A. DATA QUESTIONNAIRE IS PI-ONLY. onboard_member seeded data_questionnaire for EVERY role,
--     so postdocs/staff/students were shown (and reminded about) a step they must never own —
--     the project data questionnaire belongs to the PI. Fixes the seed AND backfills existing
--     rows by removing the key from non-PI checklists.
--  B. REAL STAGE RESOLUTION for grant_link: suggest_grants_for_investigator ranks candidate
--     grants from live data (shared email domain > shared institution), and
--     link_investigator_grant performs the association + marks the step done in one call —
--     so an admin resolves the stage instead of just ticking a box.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor.

-- ── A. PI-only data questionnaire ─────────────────────────────────────────────
-- Roles that OWN the project data questionnaire ("the PIs"). Co-investigators, trainees and
-- staff are deliberately excluded.
CREATE OR REPLACE FUNCTION public.role_owns_questionnaire(_role text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(coalesce(_role, '')) IN ('contact_pi', 'co_pi', 'mpi', 'pi')
$$;

-- Backfill: drop data_questionnaire from every non-PI checklist that has it.
UPDATE public.investigators
SET onboarding_checklist = onboarding_checklist - 'data_questionnaire'
WHERE onboarding_checklist ? 'data_questionnaire'
  AND NOT public.role_owns_questionnaire(role);

-- ── B. Grant suggestions + one-call association ───────────────────────────────
-- Ranked candidates for an unlinked investigator, from LIVE data (never invented):
--   3 = a roster member shares the target's email DOMAIN (same institution, same grant)
--   2 = a roster member's institution matches the target's institution
CREATE OR REPLACE FUNCTION public.suggest_grants_for_investigator(_investigator_id uuid)
RETURNS TABLE (grant_id uuid, grant_number text, title text, score int, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _email text;
  _domain text;
  _inst text;
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can look up grant suggestions';
  END IF;
  SELECT lower(i.email), lower(split_part(i.email, '@', 2)), nullif(trim(i.institution), '')
    INTO _email, _domain, _inst
  FROM public.investigators i WHERE i.id = _investigator_id;
  IF _email IS NULL THEN RAISE EXCEPTION 'Investigator % not found', _investigator_id; END IF;

  RETURN QUERY
  WITH peers AS (
    SELECT gi.grant_id,
           count(*) FILTER (WHERE lower(split_part(d.email, '@', 2)) = _domain) AS domain_peers,
           count(*) FILTER (WHERE _inst IS NOT NULL AND d.institution ILIKE '%' || _inst || '%') AS inst_peers
    FROM public.grant_investigators gi
    JOIN public.investigators d ON d.id = gi.investigator_id
    WHERE d.id <> _investigator_id
    GROUP BY gi.grant_id
  )
  SELECT g.id, g.grant_number, g.title,
         (CASE WHEN p.domain_peers > 0 THEN 3 ELSE 0 END + CASE WHEN p.inst_peers > 0 THEN 2 ELSE 0 END)::int AS score,
         concat_ws('; ',
           CASE WHEN p.domain_peers > 0 THEN p.domain_peers || ' member(s) at @' || _domain END,
           CASE WHEN p.inst_peers > 0 THEN p.inst_peers || ' member(s) at ' || _inst END
         ) AS reason
  FROM peers p
  JOIN public.grants g ON g.id = p.grant_id
  WHERE (p.domain_peers > 0 OR p.inst_peers > 0)
    AND NOT EXISTS (SELECT 1 FROM public.grant_investigators x
                    WHERE x.grant_id = p.grant_id AND x.investigator_id = _investigator_id)
  ORDER BY score DESC, g.grant_number
  LIMIT 8;
END;
$$;

-- Associate the investigator with a grant AND resolve the grant_link step in one call.
CREATE OR REPLACE FUNCTION public.link_investigator_grant(
  _investigator_id uuid,
  _grant_id uuid,
  _role text DEFAULT NULL   -- defaults to the investigator's own role
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _r text;
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can link a grant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.grants WHERE id = _grant_id) THEN
    RAISE EXCEPTION 'Grant % not found', _grant_id;
  END IF;
  SELECT coalesce(nullif(trim(_role), ''), role, 'research_staff') INTO _r
  FROM public.investigators WHERE id = _investigator_id;
  IF _r IS NULL THEN RAISE EXCEPTION 'Investigator % not found', _investigator_id; END IF;

  INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
  VALUES (_grant_id, _investigator_id, _r) ON CONFLICT DO NOTHING;

  UPDATE public.investigators
     SET onboarding_checklist = coalesce(onboarding_checklist, '{}'::jsonb)
                                || jsonb_build_object('grant_link', 'done')
   WHERE id = _investigator_id;

  RETURN jsonb_build_object('ok', true, 'grant_id', _grant_id, 'role', _r);
END;
$$;

-- ── C. onboard_member: seed data_questionnaire ONLY for PI roles ───────────────
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

  SELECT id, onboarding_checklist INTO _inv_id, _existing FROM public.investigators WHERE lower(email) = _email_n LIMIT 1;

  IF _inv_id IS NULL THEN
    INSERT INTO public.investigators (name, email, role, working_groups, pending_role, institution, secondary_emails)
    VALUES (trim(_name), _email_n, _role_n, _working_groups, _pending, nullif(trim(_institution), ''),
            CASE WHEN array_length(_sec, 1) > 0 THEN _sec ELSE NULL END)
    RETURNING id INTO _inv_id;
  ELSE
    UPDATE public.investigators SET
      name = coalesce(nullif(trim(_name), ''), name),
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

  _existing := coalesce(_existing, '{}'::jsonb) - 'status' - 'offboarded_at';
  -- Also drop a previously-seeded DQ step if this role does not own it.
  IF NOT public.role_owns_questionnaire(_role_n) THEN _existing := _existing - 'data_questionnaire'; END IF;

  SELECT coalesce(jsonb_object_agg(k, val), '{}'::jsonb) INTO _merged
  FROM (
    SELECT k, CASE WHEN (_existing ? k) AND public.onboarding_status_rank(_existing ->> k) >= public.onboarding_status_rank(_seed ->> k)
                   THEN _existing -> k ELSE _seed -> k END AS val
    FROM (SELECT jsonb_object_keys(_existing) AS k UNION SELECT jsonb_object_keys(_seed) AS k) keys
  ) m;

  UPDATE public.investigators SET onboarding_checklist = _merged, onboarding_completed_at = NULL WHERE id = _inv_id;

  RETURN jsonb_build_object('ok', true, 'investigator_id', _inv_id, 'email', _email_n,
                            'role', _role_n, 'grant_linked', _grant_linked, 'checklist', _merged);
END;
$$;

GRANT EXECUTE ON FUNCTION public.role_owns_questionnaire(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.suggest_grants_for_investigator(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_investigator_grant(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.onboard_member(text, text, text, text[], text, text, uuid, text[]) TO authenticated;
