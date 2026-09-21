-- repoint_grant: curator/admin RPC behind the bbqs-mcp tool of the same name. Corrects a grant to a
-- new award number — e.g. after an NIH administering-IC transfer that mints a new core number
-- (U24MH136628 -> U24DA064429, issue #385) — WITHOUT hand-written SQL. Updates the grants row and any
-- projects rows keyed on the old number, refreshes nih_link, and lets the universal recorder tag the
-- change (default source class authoritative_registry, since a repoint corrects to the registry's
-- current number; override for a pre-RePORTER funder-notice renumber). The old number is preserved in
-- data_audit_log's before-image — there is no former-number column, deliberately. Does NOT fetch
-- RePORTER metadata: follow with refresh_grant_from_reporter(new number), which (with the fiscal_year
-- sort) fills amount/abstract/publications/MPIs at the latest year. Roster links are by grant_id, so
-- they are untouched.

CREATE OR REPLACE FUNCTION public.repoint_grant(
  _grant_number         text,                                -- current number in the KG
  _new_grant_number     text,                                -- the award's current/correct number
  _reporter_project_num text DEFAULT NULL,                   -- optional full per-year string; else left for refresh
  _nih_link             text DEFAULT NULL,                   -- optional; else derived from the new number
  _source_class         text DEFAULT 'authoritative_registry'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid      uuid := auth.uid();
  _gid      uuid;
  _existing uuid;
  _projects int := 0;
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can repoint a grant';
  END IF;
  IF _new_grant_number IS NULL OR btrim(_new_grant_number) = '' THEN
    RAISE EXCEPTION 'new grant number is required';
  END IF;

  SELECT id INTO _gid FROM public.grants WHERE grant_number = _grant_number;
  IF _gid IS NULL THEN
    RAISE EXCEPTION 'Grant % not found', _grant_number;
  END IF;

  -- Refuse to collide with a DIFFERENT existing grant: repointing onto an in-use number would
  -- silently entangle two records. The caller must resolve that deliberately.
  SELECT id INTO _existing FROM public.grants WHERE grant_number = _new_grant_number AND id <> _gid;
  IF _existing IS NOT NULL THEN
    RAISE EXCEPTION 'Another grant already uses %; repoint would merge records', _new_grant_number;
  END IF;

  PERFORM public.set_actor('repoint_grant');
  PERFORM public.set_source_class(_source_class);

  UPDATE public.grants
     SET grant_number         = _new_grant_number,
         reporter_project_num  = COALESCE(_reporter_project_num, reporter_project_num),
         nih_link              = COALESCE(_nih_link,
                                   'https://reporter.nih.gov/project-details/' || _new_grant_number),
         updated_at            = now()
   WHERE id = _gid;

  UPDATE public.projects SET grant_number = _new_grant_number WHERE grant_number = _grant_number;
  GET DIAGNOSTICS _projects = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'grant_id', _gid,
    'from', _grant_number,
    'to', _new_grant_number,
    'projects_updated', _projects,
    'next', 'Run refresh_grant_from_reporter for the new number to fill metadata/publications.'
  );
END $$;

GRANT EXECUTE ON FUNCTION public.repoint_grant(text, text, text, text, text) TO authenticated;
