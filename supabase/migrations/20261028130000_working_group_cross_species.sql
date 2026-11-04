-- Add the fifth working group, WG-Cross-Species (wg-cross-species@brain-bbqs.org).
--
-- Leads Steve Chang and Dan Sanes; first meeting 2026-10-07 (the group's own notes doc in
-- CONSORTIUM/Internal/Working Groups/CrossSpecies). Token and Google-Group local part follow the
-- existing pairing (WG-ELSI <-> wg-elsi@).
--
-- Until now the four tokens were spelled out separately in canonical_working_group() and in
-- member_self_update()'s filter, so a new group needed edits in two places. working_group_tokens()
-- is now the one list; tests/guards/working-group-vocabulary checks the app surfaces against it.
--
-- canonical_working_group() also collapses separators now, so "Cross Species", "cross_species" and
-- "crossspecies" all resolve. None of the four existing tokens contains a separator, so their
-- mapping is unchanged.
--
-- Apply MANUALLY in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20261028_working_group_cross_species');

CREATE OR REPLACE FUNCTION public.working_group_tokens()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY['WG-Analytics', 'WG-Devices', 'WG-ELSI', 'WG-Standards', 'WG-Cross-Species']
$fn$;

COMMENT ON FUNCTION public.working_group_tokens() IS
  'The canonical working-group tokens stored in investigators.working_groups. One definition for the DB; tests/guards/working-group-vocabulary.test.mjs checks the app surfaces against it.';

GRANT EXECUTE ON FUNCTION public.working_group_tokens() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.canonical_working_group(_wg text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE regexp_replace(regexp_replace(lower(trim(_wg)), '^wg[-_ ]?', ''), '[-_ ]+', '', 'g')
    WHEN 'analytics'      THEN 'WG-Analytics'
    WHEN 'devices'        THEN 'WG-Devices'
    WHEN 'elsi'           THEN 'WG-ELSI'
    WHEN 'standards'      THEN 'WG-Standards'
    WHEN 'crossspecies'   THEN 'WG-Cross-Species'
    WHEN 'crossspecieswg' THEN 'WG-Cross-Species'
    ELSE _wg
  END
$$;

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

  -- Canonicalize the WG request to the valid tokens (drop anything else). NULL = leave as-is.
  IF _requested_working_groups IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT wg), '{}') INTO _req
    FROM (SELECT public.canonical_working_group(trim(w)) AS wg
          FROM unnest(_requested_working_groups) w
          WHERE w IS NOT NULL AND length(trim(w)) > 0) t
    WHERE wg = ANY (public.working_group_tokens());
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

GRANT EXECUTE ON FUNCTION public.member_self_update(text, text, text[], text[], text[], text[]) TO authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────────────────────────
-- Every spelling resolves; the four existing tokens are unchanged.
SELECT v AS input, public.canonical_working_group(v) AS token
  FROM unnest(ARRAY['Cross-Species', 'cross species', 'crossspecies', 'cross_species', 'WG-Cross-Species',
                    'wg-cross-species', 'Cross Species WG', 'WG-ELSI', 'elsi', 'WG Analytics', 'standards',
                    'Devices']) AS v;
