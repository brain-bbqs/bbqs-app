-- Deterministic onboarding RPCs for the KG-site admin console (P2). SECURITY DEFINER +
-- an explicit admin/curator gate (so they run with a clear, single authorization check),
-- centralizing the onboard write so the logic can't drift across React. Groups are
-- provisioned by the existing trg_sync_member_groups trigger when role/working_groups are
-- set; working_groups are canonicalized by trg_normalize_working_groups; every write is
-- captured by data_audit_log.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor
-- (project vpexxhfpvghlejljwpvt).

-- Rank onboarding statuses for a never-downgrade merge (done > pending/queued > rest).
CREATE OR REPLACE FUNCTION public.onboarding_status_rank(_s text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE _s WHEN 'done' THEN 2 WHEN 'pending' THEN 1 WHEN 'queued' THEN 1 ELSE 0 END
$$;

-- Onboard (or update) a member deterministically. Returns { ok, investigator_id, ... }.
CREATE OR REPLACE FUNCTION public.onboard_member(
  _email          text,
  _name           text,
  _role           text DEFAULT 'research_staff',
  _working_groups text[] DEFAULT '{}',
  _pending_role   text DEFAULT NULL,   -- 'admin' | 'curator' | anything else => member (no elevation)
  _institution    text DEFAULT NULL,
  _grant_id       uuid DEFAULT NULL    -- from the grant picker; NULL = grant-free / deferred
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid       uuid := auth.uid();
  _email_n   text := lower(trim(_email));
  _role_n    text := lower(trim(coalesce(_role, '')));
  _pending   app_role;
  _inv_id    uuid;
  _existing  jsonb;
  _seed      jsonb;
  _merged    jsonb;
  _is_pi     boolean;
  _is_trainee boolean;
  _grant_linked boolean := false;
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can onboard members';
  END IF;
  IF _email_n = '' OR _email_n !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'A valid email is required';
  END IF;
  IF coalesce(trim(_name), '') = '' THEN
    RAISE EXCEPTION 'A name is required';
  END IF;

  -- Normalize role to the canonical grant_investigators.role vocabulary; default research_staff.
  _role_n := CASE _role_n
    WHEN 'pi' THEN 'PI'
    WHEN 'contact_pi' THEN 'contact_pi'
    WHEN 'co_pi' THEN 'co_pi'
    WHEN 'mpi' THEN 'mpi'
    WHEN 'co-investigator' THEN 'co-investigator'
    WHEN 'co_investigator' THEN 'co-investigator'
    WHEN 'postdoc' THEN 'postdoc'
    WHEN 'graduate_student' THEN 'graduate_student'
    WHEN 'grad_student' THEN 'graduate_student'
    WHEN 'research_staff' THEN 'research_staff'
    WHEN 'data_manager' THEN 'data_manager'
    WHEN 'project_manager' THEN 'project_manager'
    WHEN 'nih_program' THEN 'nih_program'
    WHEN 'admin' THEN 'admin'
    WHEN 'other' THEN 'other'
    ELSE 'research_staff'
  END;
  _is_pi := _role_n IN ('PI', 'contact_pi', 'co_pi', 'mpi', 'co-investigator');
  _is_trainee := _role_n IN ('postdoc', 'graduate_student');

  -- Access tier: only curator/admin are materialized (member is the default → no pending_role).
  _pending := CASE lower(coalesce(_pending_role, ''))
    WHEN 'admin' THEN 'admin'::app_role
    WHEN 'curator' THEN 'curator'::app_role
    ELSE NULL
  END;

  IF _grant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.grants WHERE id = _grant_id) THEN
    RAISE EXCEPTION 'Grant % not found', _grant_id;
  END IF;

  -- Upsert investigator by email (never duplicate).
  SELECT id, onboarding_checklist INTO _inv_id, _existing
    FROM public.investigators WHERE lower(email) = _email_n LIMIT 1;

  IF _inv_id IS NULL THEN
    INSERT INTO public.investigators (name, email, role, working_groups, pending_role, institution)
    VALUES (trim(_name), _email_n, _role_n, _working_groups, _pending, nullif(trim(_institution), ''))
    RETURNING id INTO _inv_id;
  ELSE
    UPDATE public.investigators SET
      name           = coalesce(nullif(trim(_name), ''), name),
      role           = _role_n,
      working_groups = _working_groups,
      pending_role   = coalesce(_pending, pending_role),
      institution    = coalesce(nullif(trim(_institution), ''), institution)
    WHERE id = _inv_id;
  END IF;

  -- Grant roster link (composite key; no id column). Gated above; definer bypasses roster RLS.
  IF _grant_id IS NOT NULL THEN
    INSERT INTO public.grant_investigators (grant_id, investigator_id, role)
    VALUES (_grant_id, _inv_id, _role_n)
    ON CONFLICT DO NOTHING;
    _grant_linked := true;
  END IF;

  -- Seed the checklist reflecting what this onboard did. Group steps are 'done' because
  -- setting role/working_groups fires trg_sync_member_groups to provision them; the
  -- admin-driven steps (welcome/questionnaire/slack) remain to be completed.
  _seed := jsonb_build_object(
    'pre_check', 'done',
    'kg_created', 'done',
    'consortium_group', 'done',
    'welcome_email', 'not_started',
    'data_questionnaire', 'not_started',
    'slack', 'not_started'
  );
  IF _is_pi THEN _seed := _seed || jsonb_build_object('pi_group', 'done'); END IF;
  IF _is_trainee THEN _seed := _seed || jsonb_build_object('young_investigators_group', 'done'); END IF;
  IF coalesce(array_length(_working_groups, 1), 0) > 0 THEN
    _seed := _seed || jsonb_build_object('wg_groups', 'done');
  END IF;
  IF _grant_linked THEN
    _seed := _seed || jsonb_build_object('grant_link', 'done');
  ELSIF _is_pi THEN
    _seed := _seed || jsonb_build_object('grant_link', 'not_started');  -- PI needs a grant
  END IF;

  -- Merge with any existing checklist, never downgrading a completed step; drop offboarded marker.
  _existing := coalesce(_existing, '{}'::jsonb) - 'status' - 'offboarded_at';
  SELECT coalesce(jsonb_object_agg(k, val), '{}'::jsonb) INTO _merged
  FROM (
    SELECT k,
      CASE
        WHEN (_existing ? k) AND public.onboarding_status_rank(_existing ->> k) >= public.onboarding_status_rank(_seed ->> k)
        THEN _existing -> k
        ELSE _seed -> k
      END AS val
    FROM (
      SELECT jsonb_object_keys(_existing) AS k
      UNION
      SELECT jsonb_object_keys(_seed) AS k
    ) keys
  ) m;

  UPDATE public.investigators
     SET onboarding_checklist = _merged,
         onboarding_completed_at = NULL
   WHERE id = _inv_id;

  RETURN jsonb_build_object(
    'ok', true,
    'investigator_id', _inv_id,
    'email', _email_n,
    'role', _role_n,
    'grant_linked', _grant_linked,
    'pending_role', _pending,
    'checklist', _merged
  );
END;
$$;

-- Toggle a single onboarding step (used by the wizard after sending the welcome email, and
-- for manual ticks in the status panel). Gated to admin/curator.
CREATE OR REPLACE FUNCTION public.set_onboarding_step(
  _investigator_id uuid,
  _step            text,
  _status          text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _cl  jsonb;
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can update onboarding steps';
  END IF;
  IF _status NOT IN ('done', 'pending', 'not_started') THEN
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

GRANT EXECUTE ON FUNCTION public.onboard_member(text, text, text, text[], text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_onboarding_step(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_status_rank(text) TO authenticated;
