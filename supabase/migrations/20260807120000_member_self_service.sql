-- Member self-service profile editing (P5). "Requested interest, admin approves" for WGs.
--   • requested_working_groups: a member's WG REQUEST — does NOT drive mailing lists.
--   • member_self_update: a member edits ONLY their own row, ONLY benign fields + the WG
--     request. It NEVER writes working_groups/role/pending_role, so a member cannot
--     self-subscribe to a mailing list (column-level control the row-level RLS can't give).
--   • approve_working_groups: admin/curator promotes the request into the real
--     working_groups (which the sync trigger then provisions), clearing the request.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor.

ALTER TABLE public.investigators ADD COLUMN IF NOT EXISTS requested_working_groups text[];

-- Member edits their OWN record (benign fields) + submits a WG request.
CREATE OR REPLACE FUNCTION public.member_self_update(
  _institution              text     DEFAULT NULL,
  _orcid                    text     DEFAULT NULL,
  _research_areas           text[]   DEFAULT NULL,
  _skills                   text[]   DEFAULT NULL,
  _secondary_emails         text[]   DEFAULT NULL,
  _requested_working_groups text[]   DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _inv_id uuid;
  _req text[];
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT id INTO _inv_id FROM public.investigators WHERE user_id = _uid LIMIT 1;
  IF _inv_id IS NULL THEN RAISE EXCEPTION 'No investigator record is linked to your account'; END IF;

  -- Canonicalize the WG request to the 4 valid tokens (drop anything else). NULL = leave as-is.
  IF _requested_working_groups IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT wg), '{}') INTO _req
    FROM (SELECT public.canonical_working_group(trim(w)) AS wg
          FROM unnest(_requested_working_groups) w
          WHERE w IS NOT NULL AND length(trim(w)) > 0) t
    WHERE wg IN ('WG-Analytics', 'WG-Devices', 'WG-ELSI', 'WG-Standards');
  END IF;

  UPDATE public.investigators SET
    institution      = coalesce(nullif(trim(_institution), ''), institution),
    orcid            = coalesce(nullif(trim(_orcid), ''), orcid),
    research_areas   = coalesce(_research_areas, research_areas),
    skills           = coalesce(_skills, skills),
    secondary_emails = coalesce(_secondary_emails, secondary_emails),
    requested_working_groups = CASE WHEN _requested_working_groups IS NOT NULL THEN _req ELSE requested_working_groups END
  WHERE id = _inv_id;

  RETURN jsonb_build_object('ok', true, 'investigator_id', _inv_id);
END;
$$;

-- Admin/curator approves a member's WG request -> real working_groups (sync trigger fires).
CREATE OR REPLACE FUNCTION public.approve_working_groups(
  _investigator_id uuid,
  _groups text[] DEFAULT NULL   -- optional override; else the member's requested set
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _apply text[];
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can approve working groups';
  END IF;
  SELECT coalesce(_groups, requested_working_groups) INTO _apply FROM public.investigators WHERE id = _investigator_id;
  UPDATE public.investigators SET
    working_groups = (SELECT coalesce(array_agg(DISTINCT public.canonical_working_group(trim(w))), '{}')
                      FROM unnest(coalesce(_apply, '{}')) w WHERE w IS NOT NULL AND length(trim(w)) > 0),
    requested_working_groups = NULL
  WHERE id = _investigator_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.member_self_update(text, text, text[], text[], text[], text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_working_groups(uuid, text[]) TO authenticated;
