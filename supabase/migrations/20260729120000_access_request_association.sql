-- Access requests must state WHICH BBQS grant or PI the requester is associated with.
--
-- Why: the intake form captured name/institution/role but nothing tying the person to a
-- grant or a PI, so a reviewer had no basis to decide (or to route them to the right
-- grant roster / working groups) without chasing the requester by email. `institution`
-- is not a substitute — several BBQS grants share an institution.
--
-- `association` is free text on purpose: it holds a grant number ("U24MH136628"), a PI
-- name ("Satra Ghosh"), or the explicit self-declared "Not affiliated with a specific
-- BBQS grant or PI" the form writes when the requester ticks that box. Nullable so
-- EXISTING rows (filed before this field) stay valid and the Globus auto-file path —
-- which knows only the email — keeps working.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor
-- (project vpexxhfpvghlejljwpvt), or via the "Apply prod schema (KG)" workflow.

ALTER TABLE public.access_requests
  ADD COLUMN IF NOT EXISTS association text;

COMMENT ON COLUMN public.access_requests.association IS
  'Requester-declared BBQS association: grant number, PI/lab name, or an explicit "not affiliated" declaration. Captured by /request-access; shown in the admin review queue.';

-- Extend the single writer so the intake form can persist it. The previous 7-arg
-- signature is dropped so only ONE overload exists (two would let a caller silently
-- bypass the new field). Callers use NAMED arguments and every parameter has a
-- default, so a client that hasn't shipped the new field yet still works — it simply
-- leaves association NULL. The intake form's PGRST202 fallback also still applies.
DROP FUNCTION IF EXISTS public.upsert_access_request(text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.upsert_access_request(
  _email          text,
  _full_name      text DEFAULT NULL,
  _institution    text DEFAULT NULL,
  _requested_role text DEFAULT NULL,
  _message        text DEFAULT NULL,
  _globus_name    text DEFAULT NULL,
  _globus_subject text DEFAULT NULL,
  _association    text DEFAULT NULL
)
RETURNS TABLE (id uuid, was_created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _existing_id uuid;
BEGIN
  IF _email IS NULL OR btrim(_email) = '' THEN
    RAISE EXCEPTION 'email is required';
  END IF;

  -- Enrich an existing pending request for this email, if one exists.
  SELECT ar.id INTO _existing_id
    FROM public.access_requests ar
   WHERE lower(ar.email) = lower(_email)
     AND ar.status = 'pending'
   ORDER BY ar.updated_at DESC NULLS LAST, ar.created_at DESC NULLS LAST
   LIMIT 1;

  IF _existing_id IS NOT NULL THEN
    UPDATE public.access_requests ar SET
      full_name      = COALESCE(NULLIF(btrim(_full_name), ''), ar.full_name),
      institution    = COALESCE(NULLIF(btrim(_institution), ''), ar.institution),
      requested_role = COALESCE(NULLIF(btrim(_requested_role), ''), ar.requested_role),
      message        = COALESCE(NULLIF(btrim(_message), ''), ar.message),
      globus_name    = COALESCE(NULLIF(btrim(_globus_name), ''), ar.globus_name),
      globus_subject = COALESCE(NULLIF(btrim(_globus_subject), ''), ar.globus_subject),
      association    = COALESCE(NULLIF(btrim(_association), ''), ar.association),
      updated_at     = now()
     WHERE ar.id = _existing_id;
    RETURN QUERY SELECT _existing_id, false;
    RETURN;
  END IF;

  -- No pending row yet — insert one. Guard against a concurrent insert racing us to
  -- the unique index: fold into the row that won instead of erroring.
  BEGIN
    RETURN QUERY
      INSERT INTO public.access_requests
        (email, full_name, institution, requested_role, message, globus_name, globus_subject, association, status)
      VALUES
        (lower(_email),
         NULLIF(btrim(_full_name), ''),
         NULLIF(btrim(_institution), ''),
         NULLIF(btrim(_requested_role), ''),
         NULLIF(btrim(_message), ''),
         NULLIF(btrim(_globus_name), ''),
         NULLIF(btrim(_globus_subject), ''),
         NULLIF(btrim(_association), ''),
         'pending')
      RETURNING access_requests.id, true;
  EXCEPTION WHEN unique_violation THEN
    SELECT ar.id INTO _existing_id
      FROM public.access_requests ar
     WHERE lower(ar.email) = lower(_email) AND ar.status = 'pending'
     LIMIT 1;
    UPDATE public.access_requests ar SET
      full_name      = COALESCE(NULLIF(btrim(_full_name), ''), ar.full_name),
      institution    = COALESCE(NULLIF(btrim(_institution), ''), ar.institution),
      requested_role = COALESCE(NULLIF(btrim(_requested_role), ''), ar.requested_role),
      message        = COALESCE(NULLIF(btrim(_message), ''), ar.message),
      globus_name    = COALESCE(NULLIF(btrim(_globus_name), ''), ar.globus_name),
      globus_subject = COALESCE(NULLIF(btrim(_globus_subject), ''), ar.globus_subject),
      association    = COALESCE(NULLIF(btrim(_association), ''), ar.association),
      updated_at     = now()
     WHERE ar.id = _existing_id;
    RETURN QUERY SELECT _existing_id, false;
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_access_request(text, text, text, text, text, text, text, text)
  TO anon, authenticated, service_role;
