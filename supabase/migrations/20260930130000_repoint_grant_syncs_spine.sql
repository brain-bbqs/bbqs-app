-- repoint_grant updated grants and projects but never the grant's resources row, so after every
-- renumbering the spine kept the old award in its name and external_url (BARD.CC still says
-- U24MH136628: KG invariant #20, issue #431). It now syncs that row in the same audited call. Only a
-- name that IS an award number is rewritten (a title is left alone), and only an external_url that is
-- a RePORTER project page. nih_link now defaults to the per-year page when reporter_project_num is
-- given, so re-running on an already-repointed grant (same old and new number) re-syncs the spine
-- without degrading its link. Old values stay in data_audit_log, as before.
SELECT public.set_actor('migration:repoint_grant_syncs_spine');

CREATE OR REPLACE FUNCTION public.repoint_grant(
  _grant_number         text,
  _new_grant_number     text,
  _reporter_project_num text DEFAULT NULL,
  _nih_link             text DEFAULT NULL,
  _source_class         text DEFAULT 'authoritative_registry'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid      uuid := auth.uid();
  _gid      uuid;
  _existing uuid;
  _projects int := 0;
  _spine    int := 0;
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
                                   'https://reporter.nih.gov/project-details/'
                                   || COALESCE(_reporter_project_num, _new_grant_number)),
         updated_at            = now()
   WHERE id = _gid;

  UPDATE public.projects SET grant_number = _new_grant_number WHERE grant_number = _grant_number;
  GET DIAGNOSTICS _projects = ROW_COUNT;

  UPDATE public.resources r
     SET name = CASE WHEN r.name ~ '^[0-9]?[A-Z][A-Z0-9]{2}[A-Z]{2}[0-9]{6}(-[0-9A-Z]+)?$'
                     THEN _new_grant_number ELSE r.name END,
         external_url = CASE WHEN r.external_url ~ '^https?://reporter\.nih\.gov/project-details/'
                             THEN g.nih_link ELSE r.external_url END,
         updated_at = now()
    FROM public.grants g
   WHERE g.id = _gid AND r.id = g.resource_id
     AND (   (r.name ~ '^[0-9]?[A-Z][A-Z0-9]{2}[A-Z]{2}[0-9]{6}(-[0-9A-Z]+)?$' AND r.name IS DISTINCT FROM _new_grant_number)
          OR (r.external_url ~ '^https?://reporter\.nih\.gov/project-details/' AND r.external_url IS DISTINCT FROM g.nih_link));
  GET DIAGNOSTICS _spine = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'grant_id', _gid,
    'from', _grant_number,
    'to', _new_grant_number,
    'projects_updated', _projects,
    'spine_row_updated', _spine = 1,
    'next', 'Run refresh_grant_from_reporter for the new number to fill metadata/publications.'
  );
END $$;

GRANT EXECUTE ON FUNCTION public.repoint_grant(text, text, text, text, text) TO authenticated;
