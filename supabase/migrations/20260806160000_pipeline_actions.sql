-- Interactive pipeline (P4) + secondary-email support.
--   • set_onboarding_step now accepts 'skipped' (Dismiss) as well as done/pending/not_started.
--   • onboarding_pipeline + onboarding_status_rank treat 'skipped' as COMPLETE (so a dismissed
--     step no longer counts as remaining / stuck).
--   • onboard_member gains _secondary_emails (written to investigators.secondary_emails —
--     used for Globus/mailing-list matching; previously dropped by the console path).
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor.

-- done OR skipped == complete (rank 2)
CREATE OR REPLACE FUNCTION public.onboarding_status_rank(_s text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE _s WHEN 'done' THEN 2 WHEN 'skipped' THEN 2 WHEN 'pending' THEN 1 WHEN 'queued' THEN 1 ELSE 0 END
$$;

-- Pipeline view: count done+skipped as complete; required-incomplete excludes both.
CREATE OR REPLACE VIEW public.onboarding_pipeline
WITH (security_invoker = true)
AS
WITH base AS (
  SELECT i.id, i.name, i.email, i.role, i.working_groups, i.created_at,
         i.onboarding_checklist AS checklist,
         coalesce((SELECT count(*) FROM public.grant_investigators gi WHERE gi.investigator_id = i.id), 0) AS live_grant_count
  FROM public.investigators i
  WHERE i.onboarding_completed_at IS NULL
    AND i.onboarding_checklist ->> 'pre_check' = 'done'
    AND coalesce(i.onboarding_checklist ->> 'status', '') <> 'offboarded'
),
steps AS (
  SELECT b.id,
    count(*) FILTER (WHERE kv.key NOT IN ('status','offboarded_at','pre_check')) AS steps_total,
    count(*) FILTER (WHERE kv.key NOT IN ('status','offboarded_at','pre_check') AND kv.value IN ('done','skipped')) AS steps_done,
    count(*) FILTER (WHERE kv.key NOT IN ('status','offboarded_at','pre_check','wg_groups','working_groups') AND kv.value NOT IN ('done','skipped')) AS required_incomplete,
    count(*) FILTER (WHERE kv.key NOT IN ('status','offboarded_at','pre_check') AND kv.value IN ('pending','queued')) AS steps_in_flight
  FROM base b
  LEFT JOIN LATERAL jsonb_each_text(b.checklist) AS kv ON true
  GROUP BY b.id
)
SELECT b.id, b.name, b.email, b.role, b.working_groups, b.created_at, b.checklist, b.live_grant_count,
  floor(extract(epoch FROM (now() - b.created_at)) / 86400)::int AS days_since_created,
  coalesce(s.steps_done, 0) AS steps_done,
  coalesce(s.steps_total, 0) AS steps_total,
  (floor(extract(epoch FROM (now() - b.created_at)) / 86400) > 14 AND coalesce(s.required_incomplete, 0) > 0) AS is_stuck
FROM base b JOIN steps s ON s.id = b.id
WHERE b.live_grant_count > 0 OR coalesce(s.steps_in_flight, 0) > 0;

-- set_onboarding_step: allow 'skipped'
CREATE OR REPLACE FUNCTION public.set_onboarding_step(
  _investigator_id uuid, _step text, _status text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid(); _cl jsonb;
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can update onboarding steps';
  END IF;
  IF _status NOT IN ('done', 'pending', 'not_started', 'skipped') THEN
    RAISE EXCEPTION 'Invalid status %', _status;
  END IF;
  UPDATE public.investigators
     SET onboarding_checklist = coalesce(onboarding_checklist, '{}'::jsonb) || jsonb_build_object(_step, _status)
   WHERE id = _investigator_id
   RETURNING onboarding_checklist INTO _cl;
  IF NOT FOUND THEN RAISE EXCEPTION 'Investigator % not found', _investigator_id; END IF;
  RETURN jsonb_build_object('ok', true, 'checklist', _cl);
END;
$$;

-- onboard_member: add _secondary_emails (drop the old 7-arg signature first to avoid an overload)
DROP FUNCTION IF EXISTS public.onboard_member(text, text, text, text[], text, text, uuid);

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
  _inv_id uuid;
  _existing jsonb;
  _seed jsonb;
  _merged jsonb;
  _is_pi boolean;
  _is_trainee boolean;
  _grant_linked boolean := false;
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

  _seed := jsonb_build_object('pre_check','done','kg_created','done','consortium_group','done',
                              'welcome_email','not_started','data_questionnaire','not_started','slack','not_started');
  IF _is_pi THEN _seed := _seed || jsonb_build_object('pi_group', 'done'); END IF;
  IF _is_trainee THEN _seed := _seed || jsonb_build_object('young_investigators_group', 'done'); END IF;
  IF coalesce(array_length(_working_groups, 1), 0) > 0 THEN _seed := _seed || jsonb_build_object('wg_groups', 'done'); END IF;
  IF _grant_linked THEN _seed := _seed || jsonb_build_object('grant_link', 'done');
  ELSIF _is_pi THEN _seed := _seed || jsonb_build_object('grant_link', 'not_started'); END IF;

  _existing := coalesce(_existing, '{}'::jsonb) - 'status' - 'offboarded_at';
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

GRANT EXECUTE ON FUNCTION public.onboard_member(text, text, text, text[], text, text, uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_onboarding_step(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_status_rank(text) TO authenticated;
