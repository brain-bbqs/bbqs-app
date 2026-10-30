-- import_questionnaire_response(): record one BBQS Data Questionnaire response on its project, over MCP.
--
-- Every response so far reached the KG through a hand-written migration (20260417*, 20260810140000,
-- 20260826170000), each re-deriving the same rules. This is the tool 20260810140000 anticipated.
-- The rules it now enforces in one place:
--
--   * PROVENANCE G2 questionnaire, credited to the RESPONDENT. set_actor(respondent) makes
--     enforce_field_provenance record every written key against the person who answered, as the
--     SMART-DBS import did. data_audit_log.actor_id is still auth.uid(), so who ran the import stays
--     on record separately from who answered.
--   * FILL-ONLY-EMPTY. A key already holding an answer (jsonb_is_answered) is skipped and reported,
--     never overwritten. Re-running is therefore safe.
--   * ATTRIBUTION KEYS questionnaire_submitted_by / _at / _response_id, which
--     project_questionnaire_status reads to judge the submitter against the grant roster. Written only
--     when this response actually filled something, so a no-op re-import cannot claim authorship.
--   * KEYS MUST BE REAL. An answer key outside questionnaire_metadata_keys() rejects the whole call:
--     a mapping mistake fails loudly instead of landing a stray key. That list mirrors
--     src/data/questionnaire-fields.ts and tests/guards/questionnaire-keys-parity checks they match.
--
-- Mapping form answers to keys, and trimming option glosses to the stored convention, stays with the
-- caller: several answers need judgement (see 20260826170000's three hand-read lists).
--
-- Known gap, as before: claims carry recorded_at, not the submission date as authored_at.
--
-- Apply MANUALLY in the KG SQL editor (vpexxhfpvghlejljwpvt), then deploy bbqs-mcp.

SELECT public.set_actor('migration:20261028_import_questionnaire_response');

CREATE OR REPLACE FUNCTION public.questionnaire_metadata_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    'planning_priorities', 'planning_priorities_other',
    'data_types_collected', 'data_types_other',
    'use_sensors', 'neural_recording_details',
    'behavioral_recording_tech', 'behavioral_brands', 'behavioral_recording_details',
    'hand_coding_method', 'behaviors_of_interest', 'behaviors_details',
    'neural_data_size_per_year', 'neural_data_size_details',
    'behavioral_data_size_per_year', 'behavioral_data_size_details', 'single_unit_upload_size',
    'brain_initiative_standards', 'standards_other', 'standards_conversion_tools',
    'conversion_tools_details', 'standards_lifecycle_stages', 'standards_usage_description',
    'metadata_gaps',
    'neural_data_formats', 'neural_formats_other', 'behavioral_data_formats',
    'behavioral_formats_other', 'formats_usage_description',
    'ontologies_used', 'ontologies_other', 'ontologies_usage', 'ontologies_usage_details',
    'data_management_systems', 'data_management_other', 'primary_storage', 'primary_storage_details',
    'uses_backups', 'data_sync_methods', 'data_sync_other',
    'neural_feature_detection', 'neural_feature_detection_other',
    'behavioral_feature_detection', 'behavioral_feature_detection_other', 'feature_detection_software',
    'analysis_languages', 'analysis_languages_other', 'use_analysis_method', 'analysis_methods_other',
    'use_analysis_types', 'analysis_types_other', 'analysis_software', 'analysis_software_other',
    'analysis_platforms', 'analysis_platforms_other', 'reliability_methods', 'reliability_methods_other',
    'data_archives', 'data_archives_other', 'other_sharing_methods', 'other_sharing_details',
    'ember_earliest_date', 'ember_data_nature', 'release_terms', 'all_data_public_immediately',
    'restricted_access_scope', 'persistent_identifiers', 'persistent_identifiers_usage',
    'reuse_data_origins', 'reuse_data_origins_details', 'reuse_purposes', 'reuse_purposes_details',
    'reuse_sources', 'reuse_sources_other', 'reuse_challenges',
    'help_needed', 'resources_to_share', 'additional_info'
  ]
$fn$;

COMMENT ON FUNCTION public.questionnaire_metadata_keys() IS
  'Every projects.metadata key a Data Questionnaire answer may set. Mirrors the non-topLevel fields of src/data/questionnaire-fields.ts; tests/guards/questionnaire-keys-parity.test.mjs fails if they diverge.';

GRANT EXECUTE ON FUNCTION public.questionnaire_metadata_keys() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.import_questionnaire_response(
  _grant_number     text,
  _respondent_email text,
  _answers          jsonb,
  _submitted_at     timestamptz DEFAULT NULL,
  _response_id      text        DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid      uuid := auth.uid();
  _gn       text := upper(regexp_replace(btrim(coalesce(_grant_number, '')), '-\d+$', ''));
  _resp     text := lower(btrim(coalesce(_respondent_email, '')));
  _n        int;
  _pid      uuid;
  _current  jsonb;
  _key      text;
  _val      jsonb;
  _unknown  text[] := '{}';
  _write    jsonb  := '{}'::jsonb;
  _written  text[] := '{}';
  _skipped  text[] := '{}';
  _empty    text[] := '{}';
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can import questionnaire responses';
  END IF;
  IF _resp !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'A valid respondent email is required';
  END IF;
  IF _answers IS NULL OR jsonb_typeof(_answers) <> 'object' THEN
    RAISE EXCEPTION 'answers must be a JSON object of questionnaire key -> value';
  END IF;

  SELECT array_agg(k ORDER BY k) INTO _unknown
    FROM jsonb_object_keys(_answers) AS k
   WHERE NOT (k = ANY (public.questionnaire_metadata_keys()));
  IF coalesce(array_length(_unknown, 1), 0) > 0 THEN
    RAISE EXCEPTION 'Not questionnaire keys (nothing written): %', array_to_string(_unknown, ', ')
      USING HINT = 'Valid keys: SELECT unnest(public.questionnaire_metadata_keys())';
  END IF;

  SELECT count(*) INTO _n FROM public.projects WHERE grant_number = _gn;
  IF _n = 0 THEN RAISE EXCEPTION 'No project for grant %', _gn; END IF;
  IF _n > 1 THEN RAISE EXCEPTION 'Grant % has % project rows; resolve that first', _gn, _n; END IF;
  SELECT id, coalesce(metadata, '{}'::jsonb) INTO _pid, _current
    FROM public.projects WHERE grant_number = _gn;

  IF _response_id IS NOT NULL AND _current ->> 'questionnaire_response_id' = _response_id THEN
    RETURN jsonb_build_object('ok', true, 'already_imported', true, 'grant_number', _gn,
                              'response_id', _response_id);
  END IF;

  FOR _key, _val IN SELECT key, value FROM jsonb_each(_answers) ORDER BY key LOOP
    IF NOT public.jsonb_is_answered(_val) THEN
      _empty := _empty || _key;
    ELSIF public.jsonb_is_answered(_current -> _key) THEN
      _skipped := _skipped || _key;
    ELSE
      _write := _write || jsonb_build_object(_key, _val);
      _written := _written || _key;
    END IF;
  END LOOP;

  IF coalesce(array_length(_written, 1), 0) > 0 THEN
    IF NOT public.jsonb_is_answered(_current -> 'questionnaire_submitted_by') THEN
      _write := _write || jsonb_build_object(
        'questionnaire_submitted_by', _resp,
        'questionnaire_submitted_at', to_jsonb(coalesce(_submitted_at, now())));
      IF _response_id IS NOT NULL THEN
        _write := _write || jsonb_build_object('questionnaire_response_id', _response_id);
      END IF;
    END IF;

    -- The respondent authored these values; the trigger records each changed key against them.
    PERFORM public.set_actor(_resp);
    PERFORM public.set_source_class('questionnaire');
    UPDATE public.projects
       SET metadata = _current || _write,
           last_edited_by = _resp
     WHERE id = _pid;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'grant_number', _gn,
    'project_id', _pid,
    'respondent', _resp,
    'written', to_jsonb(_written),
    'skipped_already_answered', to_jsonb(_skipped),
    'ignored_empty', to_jsonb(_empty),
    'next', 'set_onboarding_step(<contact PI investigator_id>, ''data_questionnaire'', ''done'') once the PI''s project is recorded'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.import_questionnaire_response(text, text, jsonb, timestamptz, text) TO authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────────────────────────
SELECT array_length(public.questionnaire_metadata_keys(), 1) AS allowlist_keys;  -- expect 78
SELECT pg_get_function_identity_arguments('public.import_questionnaire_response'::regproc) AS args;
