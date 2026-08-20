-- Attribute the questionnaire answers to the people who actually answered, and record the
-- AI-assisted authorship of the consortium own analytical layer. Feature 012 P1b. Constitution v1.8.1 Principle XI.
--
-- WHY THIS EXISTS AT ALL. 20260819130000 recorded 1189 cells as 'unknown' because nothing in the
-- LIVE database said where they came from. That was the honest reading of the live state, and it was
-- wrong about the world: the attribution existed, in git.
--
-- WHAT THE EVIDENCE IS. Five migrations dated 2026-04-17 imported the questionnaire in a batch, and
-- each UPDATE names the respondent in the statement itself:
--     UPDATE public.projects SET last_edited_by = 'dhs1@nyu.edu', ... WHERE grant_number = '1U01DA063581'
-- Seventeen projects, seventeen addresses. Every one appears as a respondent in the current Google
-- Form response sheet (21 responses: 19 project responses, plus two NIH program officers who
-- answered "NIH PO" instead of selecting a grant). 17 of 17 confirmed. The per-project key lists
-- below are taken verbatim from those migrations, so each respondent is credited with exactly the
-- fields their own answers populated and nothing else.
--
-- WHY THE LIVE COLUMN LOST IT. last_edited_by now reads 'ai-assistant', 'seed-script', 'reporter-fix'
-- or NULL for those same projects. One later row-level write erased the authorship of every field in
-- the row. That is the case for per-cell provenance in one sentence: a single actor column cannot
-- survive a second edit, and the value it held was the only record of who answered a 40-question form.
--
-- THE CONSORTIUM'S OWN LAYER is not questionnaire data. Sixteen metadata keys -- the Marr levels,
-- cross-project synergy, target species domain, plus use_approaches, produce_data_modality/type,
-- devices, data_analysis_approach, develope_hardware/software_type, collaborators, presentations and
-- related_project_ids -- share one 26-project footprint and were written by Nader with Gemini 3 Pro
-- on or about 2026-03-06 (stated by the author, 2026-08-19). They are recorded as curated_with_ai:
-- human-attributed and human-accountable, with the model named so a factual error can be scoped to
-- what produced it.
--
-- 20260819130000 got this wrong twice -- it recorded 125 of those cells as 'unknown' and credited 5
-- to Wilbrecht's form submission, because R34DA062119 holds both a response and this layer. Both are
-- corrected here. The reverse mistake was checked for too before extending the set: none of the ten
-- added keys appears in any project's April questionnaire list, none was written by the August
-- import, and no form question matches any of them.
--
-- APPEND-ONLY, so nothing is rewritten: these INSERTs add newer claims and field_provenance_current
-- takes the newest per cell. The wrong 'unknown' and misattributed 'questionnaire' rows remain
-- visible as history, which is the point of an append-only store.
--
-- NO NEW DATA TO IMPORT. All 19 project responses in the sheet are already in the KG (17 in April,
-- Wilbrecht and Ghuman in August). Coverage was checked response by response: the KG holds at least
-- as many keys as each response has non-empty answers, with a total shortfall of about two fields.
-- This migration changes provenance, not data.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260819140000');

-- 1. The source class the ladder was missing (Constitution v1.8.1).
INSERT INTO public.source_classes (code, rank, label, agent_kind, is_verified, description) VALUES
  ('curated_with_ai', 4, 'Curated with AI', 'human', true,
   'Authored by a named person working with an AI assistant. Human-attributed and human-accountable, so it is verified -- but a model contributed wording and sometimes facts, and factual details (species, numbers, identifiers) deserve a re-check against tier 1.')
ON CONFLICT (code) DO UPDATE
  SET rank = excluded.rank, label = excluded.label, agent_kind = excluded.agent_kind,
      is_verified = excluded.is_verified, description = excluded.description;

-- 2. When the VALUE was authored, which is not when the provenance row was logged. The Marr layer
--    was written in March and recorded in August; dating it August would misstate its model era.
ALTER TABLE public.field_provenance ADD COLUMN IF NOT EXISTS authored_at timestamptz;
ALTER TABLE public.field_provenance ADD COLUMN IF NOT EXISTS authored_at_precision text;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'field_provenance_authored_precision_ck') THEN
    ALTER TABLE public.field_provenance
      ADD CONSTRAINT field_provenance_authored_precision_ck
      CHECK (authored_at_precision IS NULL
             OR authored_at_precision IN ('exact', 'day', 'month', 'approximate'));
  END IF;
END
$do$;

COMMENT ON COLUMN public.field_provenance.authored_at IS
  'When the VALUE was created, not when this provenance row was logged. NULL means unknown.';
COMMENT ON COLUMN public.field_provenance.authored_at_precision IS
  'How firm authored_at is. "on or about March 6" is real information and so is its fuzziness; an exact timestamp would invent precision and NULL would discard a usable date.';

-- 3. The keys that are the consortium's analytical layer, not form answers. Defined once because
--    three separate backfills have to agree about this set.
CREATE OR REPLACE FUNCTION public.ai_authored_metadata_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    -- The Marr layer proper.
    'marr_l1_ethological_goal', 'marr_l2_algorithmic_function',
    'marr_l3_implementational_hardware', 'cross_project_synergy',
    'target_species_domain', 'agentic_action_required',
    -- The rest of the same authoring batch, confirmed by the author on 2026-08-19. Same 26-project
    -- footprint as the Marr keys, and checked three ways before being claimed: none appears in any
    -- project's 2026-04-17 questionnaire key list, none was written by the August import of the two
    -- form responses, and the form itself asks no question matching any of them (searched all 85
    -- response-sheet headers for collaborat / presentation / related project / device / approach /
    -- modality -- no match). Claiming a form answer as AI-authored would be the same misattribution
    -- this function exists to prevent, just pointing the other way.
    'use_approaches', 'produce_data_modality', 'produce_data_type', 'devices',
    'data_analysis_approach', 'develope_hardware_type', 'develope_software_type',
    'collaborators', 'presentations', 'related_project_ids'
  ]::text[]
$fn$;

COMMENT ON FUNCTION public.ai_authored_metadata_keys() IS
  'Project metadata keys authored by the consortium (a named human with an AI assistant), NOT collected by the questionnaire. The form asks no question matching any of them, so crediting these to a form respondent would attribute work they did not do.';

GRANT EXECUTE ON FUNCTION public.ai_authored_metadata_keys() TO authenticated, service_role;

-- 4. Recording helper gains the authoring date.
CREATE OR REPLACE FUNCTION public.record_field_provenance(
  _table text, _id uuid, _column text, _source_class text, _activity text,
  _agent_label text DEFAULT NULL, _source_ref text DEFAULT NULL, _value text DEFAULT NULL,
  _evidence text DEFAULT NULL, _model_id text DEFAULT NULL, _confidence numeric DEFAULT NULL,
  _authored_at timestamptz DEFAULT NULL, _authored_at_precision text DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _new_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.source_classes WHERE code = _source_class) THEN
    RAISE EXCEPTION 'Unknown source_class %. Valid: %',
      _source_class, (SELECT string_agg(code, ', ' ORDER BY rank, code) FROM public.source_classes);
  END IF;

  IF _source_class = 'llm_extract' AND coalesce(btrim(_model_id), '') = '' THEN
    RAISE EXCEPTION 'llm_extract provenance requires _model_id so the claim can be re-checked.';
  END IF;

  INSERT INTO public.field_provenance (
    entity_table, entity_id, entity_column, source_class, activity,
    agent_id, agent_label, source_ref, value_text, evidence, model_id, confidence,
    authored_at, authored_at_precision)
  VALUES (
    _table, _id, _column, _source_class, _activity, auth.uid(),
    coalesce(nullif(btrim(_agent_label), ''), public.current_actor_via()),
    _source_ref, _value, _evidence, _model_id, _confidence, _authored_at,
    CASE WHEN _authored_at IS NULL THEN NULL
         ELSE coalesce(nullif(btrim(_authored_at_precision), ''), 'exact') END)
  RETURNING id INTO _new_id;

  RETURN _new_id;
END;
$fn$;

-- 5. Tier 2: the questionnaire cells, credited to the respondent who answered them, with the
--    submission timestamp from the response sheet as the authoring date.
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, evidence,
  authored_at, authored_at_precision, recorded_by)
SELECT 'projects', p.id, 'metadata.' || k.key, 'questionnaire', 'google_form_response',
       c.email,
       'Google Form response sheet 1L-S0573a4sS3iDanucQHMeSypmffP6Qm9kwgX7zOzn8; imported 2026-04-17',
       left(p.metadata ->> k.key, 500),
       'Respondent recovered from the 2026-04-17 import migrations, which set last_edited_by to this address; the address is confirmed present in the current response sheet.',
       c.submitted_at,
       CASE WHEN c.submitted_at IS NOT NULL THEN 'exact' END,
       'migration:20260819140000'
  FROM (VALUES
    ('R34DA059506', 'timothy.dunn@duke.edu', '2025-01-30 14:08:22'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_details','behavioral_recording_tech','behaviors_of_interest','data_management_other','data_management_systems','data_sync_methods','data_types_collected','feature_detection_software','hand_coding_method','metadata_gaps','other_sharing_methods','persistent_identifiers','planning_priorities','primary_storage','reliability_methods','reuse_data_origins','reuse_purposes','reuse_sources','single_unit_upload_size','use_analysis_method','use_analysis_types']::text[]),
    ('R34DA059507', 'marcschm@sas.upenn.edu', '2025-02-16 21:24:38'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_details','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','data_archives','data_management_systems','data_sync_methods','data_types_collected','feature_detection_software','neural_data_formats','neural_data_size_per_year','neural_feature_detection','ontologies_used','other_sharing_methods','persistent_identifiers','planning_priorities','primary_storage','reliability_methods','reuse_data_origins','reuse_purposes','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','use_analysis_method','use_analysis_types','use_sensors','uses_backups']::text[]),
    ('R34DA059510', 'pmcgrath7@gatech.edu', '2025-03-12 15:52:30'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','conversion_tools_details','data_management_systems','data_sync_methods','data_types_collected','ember_earliest_date','feature_detection_software','formats_usage_description','hand_coding_method','neural_data_formats','neural_data_size_per_year','neural_feature_detection','other_sharing_methods','persistent_identifiers','planning_priorities','primary_storage','reliability_methods','restricted_access_scope','reuse_challenges','reuse_data_origins','reuse_purposes','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','standards_other','standards_usage_description','use_analysis_method','use_analysis_types','use_sensors']::text[]),
    ('R34DA059513', 'ds5577@nyu.edu', '2025-01-30 10:59:15'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','conversion_tools_details','data_archives','data_management_systems','data_sync_methods','data_types_collected','feature_detection_software','hand_coding_method','neural_data_formats','neural_data_size_per_year','neural_feature_detection','ontologies_usage','ontologies_used','other_sharing_methods','planning_priorities','primary_storage','reliability_methods','reuse_data_origins','reuse_purposes','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','use_analysis_method','use_analysis_types','use_sensors']::text[]),
    ('R34DA059514', 'caleb.kemere@rice.edu', '2025-03-04 06:14:34'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_tech','behaviors_details','behaviors_of_interest','brain_initiative_standards','data_management_systems','data_sync_methods','data_types_collected','ember_data_nature','ember_earliest_date','neural_data_formats','neural_data_size_per_year','neural_feature_detection','other_sharing_methods','persistent_identifiers','persistent_identifiers_usage','planning_priorities','primary_storage','reliability_methods','reuse_data_origins','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','use_analysis_method','use_analysis_types','use_sensors']::text[]),
    ('R34DA059716', 'cheryl.corcoran@mssm.edu', '2025-02-12 14:09:59'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_tech','behaviors_details','behaviors_of_interest','brain_initiative_standards','data_archives','data_management_systems','data_sync_methods','data_types_collected','ember_earliest_date','feature_detection_software','hand_coding_method','neural_data_formats','neural_data_size_per_year','neural_feature_detection','ontologies_used','other_sharing_methods','persistent_identifiers','planning_priorities','primary_storage','reliability_methods','restricted_access_scope','reuse_data_origins','reuse_purposes','reuse_sources','standards_conversion_tools','standards_lifecycle_stages','use_analysis_method','use_analysis_types','use_sensors','uses_backups']::text[]),
    ('R34DA059718', 'npadillacoreano@ufl.edu', '2025-02-20 10:10:48'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_feature_detection_other','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','data_archives','data_management_other','data_management_systems','data_sync_methods','data_types_collected','ember_data_nature','ember_earliest_date','hand_coding_method','neural_formats_other','ontologies_other','ontologies_usage','ontologies_usage_details','ontologies_used','persistent_identifiers_usage','planning_priorities','primary_storage','reliability_methods','reuse_data_origins','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','use_analysis_method','use_analysis_types']::text[]),
    ('R34DA059723', 'g-shepherd@northwestern.edu', '2025-03-03 14:38:52'::timestamptz, ARRAY['additional_info','all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_formats_other','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','data_management_systems','data_sync_methods','data_types_collected','ember_data_nature','ember_earliest_date','feature_detection_software','formats_usage_description','hand_coding_method','metadata_gaps','neural_data_size_per_year','neural_feature_detection_other','neural_formats_other','ontologies_other','persistent_identifiers','persistent_identifiers_usage','planning_priorities','planning_priorities_other','primary_storage','reliability_methods','reuse_data_origins','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','standards_usage_description','use_analysis_method','use_analysis_types','use_sensors']::text[]),
    ('R34DA061924', 'mengsen@msu.edu', '2025-02-24 17:53:28'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_details','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','data_archives','data_management_systems','data_sync_methods','data_types_collected','ember_earliest_date','feature_detection_software','hand_coding_method','help_needed','neural_data_formats','neural_data_size_per_year','neural_feature_detection','neural_feature_detection_other','ontologies_usage','ontologies_used','other_sharing_methods','persistent_identifiers','persistent_identifiers_usage','planning_priorities','primary_storage','reliability_methods','resources_to_share','restricted_access_scope','reuse_challenges','reuse_data_origins','reuse_purposes','reuse_sources','reuse_sources_other','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','standards_other','use_analysis_method','use_analysis_types','use_sensors']::text[]),
    ('R34DA061925', 'jbeehner@umich.edu', '2025-08-08 10:49:22'::timestamptz, ARRAY['additional_info','all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_formats_other','behavioral_recording_tech','behaviors_details','behaviors_of_interest','data_management_other','data_management_systems','data_sync_methods','data_types_collected','data_types_other','hand_coding_method','help_needed','neural_data_size_per_year','neural_recording_details','other_sharing_methods','planning_priorities','planning_priorities_other','primary_storage','primary_storage_details','reliability_methods','resources_to_share','reuse_data_origins','reuse_purposes','single_unit_upload_size','use_analysis_method','use_analysis_types']::text[]),
    ('R61MH135106', 'mvallejomartelo@mednet.ucla.edu', '2025-02-11 14:30:09'::timestamptz, ARRAY['additional_info','all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','data_archives','data_management_systems','data_sync_methods','data_sync_other','data_types_collected','ember_data_nature','ember_earliest_date','hand_coding_method','help_needed','metadata_gaps','neural_data_formats','neural_data_size_per_year','neural_feature_detection','neural_feature_detection_other','ontologies_usage','ontologies_used','other_sharing_methods','persistent_identifiers','planning_priorities','primary_storage','reliability_methods','resources_to_share','reuse_challenges','reuse_data_origins','reuse_purposes','reuse_sources','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','use_analysis_method','use_analysis_types','use_sensors']::text[]),
    ('R61MH135109', 'alireza.kazemi@utah.edu', '2025-03-04 18:39:56'::timestamptz, ARRAY['analysis_languages','analysis_platforms','analysis_software','analysis_software_other','analysis_types_other','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_formats_other','behavioral_recording_tech','behaviors_details','behaviors_of_interest','brain_initiative_standards','data_archives','data_management_systems','data_sync_methods','data_types_collected','feature_detection_software','formats_usage_description','hand_coding_method','metadata_gaps','neural_data_formats','neural_data_size_per_year','neural_feature_detection','ontologies_other','ontologies_usage','ontologies_used','other_sharing_methods','persistent_identifiers','planning_priorities','primary_storage','reliability_methods','resources_to_share','reuse_challenges','reuse_data_origins','reuse_purposes','reuse_sources','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','standards_usage_description','use_analysis_method','use_analysis_types','use_sensors']::text[]),
    ('R61MH138612', 'Sima.mofakham@stonybrookmedicine.edu', '2026-03-27 12:35:37'::timestamptz, ARRAY['additional_info','all_data_public_immediately','analysis_languages','analysis_software','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','conversion_tools_details','data_archives_other','data_management_systems','data_sync_methods','data_types_collected','ember_data_nature','ember_earliest_date','formats_usage_description','hand_coding_method','help_needed','metadata_gaps','neural_data_formats','neural_data_size_per_year','neural_feature_detection','ontologies_usage','ontologies_used','other_sharing_details','other_sharing_methods','persistent_identifiers','persistent_identifiers_usage','planning_priorities','primary_storage','reliability_methods','resources_to_share','reuse_challenges','reuse_data_origins','reuse_data_origins_details','reuse_purposes','reuse_purposes_details','reuse_sources','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','standards_other','standards_usage_description','use_analysis_method','use_analysis_types','use_sensors']::text[]),
    ('R61MH138713', 'alenarto@g.ucla.edu', '2025-06-13 13:12:21'::timestamptz, ARRAY['additional_info','all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_feature_detection_other','behavioral_formats_other','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','conversion_tools_details','data_archives','data_archives_other','data_management_systems','data_sync_methods','data_types_collected','data_types_other','ember_data_nature','ember_earliest_date','feature_detection_software','hand_coding_method','help_needed','metadata_gaps','neural_data_size_per_year','neural_feature_detection','neural_formats_other','ontologies_other','ontologies_usage','ontologies_used','other_sharing_methods','persistent_identifiers_usage','planning_priorities','planning_priorities_other','primary_storage','reliability_methods','resources_to_share','restricted_access_scope','reuse_challenges','reuse_data_origins','reuse_purposes','reuse_sources','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','standards_usage_description','use_analysis_method','use_analysis_types','use_sensors']::text[]),
    ('U01DA063534', 'taylor.wise@yale.edu', '2025-11-25 12:45:07'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_tech','behaviors_details','behaviors_of_interest','brain_initiative_standards','conversion_tools_details','data_archives','data_management_systems','data_sync_methods','data_types_collected','ember_data_nature','ember_earliest_date','feature_detection_software','hand_coding_method','help_needed','metadata_gaps','ontologies_usage','ontologies_used','other_sharing_methods','persistent_identifiers','planning_priorities','primary_storage','reliability_methods','resources_to_share','restricted_access_scope','reuse_data_origins','reuse_purposes','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','standards_other','standards_usage_description','use_analysis_method','use_analysis_types']::text[]),
    ('U01DA063565', 'robert.froemke@med.nyu.edu', '2026-03-30 20:03:31'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','data_archives','data_management_systems','data_sync_methods','data_types_collected','ember_earliest_date','hand_coding_method','neural_data_formats','neural_data_size_per_year','neural_feature_detection','ontologies_usage','ontologies_used','other_sharing_methods','persistent_identifiers','persistent_identifiers_usage','planning_priorities','primary_storage','reliability_methods','resources_to_share','reuse_challenges','reuse_data_origins','reuse_data_origins_details','reuse_purposes','reuse_sources_other','single_unit_upload_size','standards_lifecycle_stages','standards_other','use_analysis_method','use_analysis_types','use_sensors']::text[]),
    ('U01DA063581', 'dhs1@nyu.edu', '2026-03-27 14:03:48'::timestamptz, ARRAY['all_data_public_immediately','analysis_languages','analysis_platforms','analysis_software','behavioral_brands','behavioral_data_formats','behavioral_data_size_per_year','behavioral_feature_detection','behavioral_formats_other','behavioral_recording_tech','behaviors_of_interest','brain_initiative_standards','data_archives','data_archives_other','data_management_other','data_management_systems','data_sync_methods','data_types_collected','data_types_other','ember_data_nature','ember_earliest_date','formats_usage_description','hand_coding_method','help_needed','metadata_gaps','neural_data_formats','neural_data_size_per_year','neural_feature_detection','neural_formats_other','neural_recording_details','ontologies_other','ontologies_usage','ontologies_used','other_sharing_methods','persistent_identifiers','planning_priorities','planning_priorities_other','primary_storage','reliability_methods','resources_to_share','restricted_access_scope','reuse_data_origins','single_unit_upload_size','standards_conversion_tools','standards_lifecycle_stages','standards_other','standards_usage_description','use_analysis_method','use_analysis_types','use_sensors']::text[])
       ) AS c(grant_number, email, submitted_at, keys)
  JOIN public.projects p ON p.grant_number = c.grant_number
 CROSS JOIN LATERAL unnest(c.keys) AS k(key)
 WHERE btrim(coalesce(p.metadata ->> k.key, '')) <> ''
   AND NOT (k.key = ANY (public.ai_authored_metadata_keys()));

-- 6. Tier 4 curated_with_ai: the consortium's own authored layer, all 16 keys, on every project
--    that has it (~396 cells). Supersedes both the cells recorded as 'unknown' and the 5 credited to
--    a form respondent.
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, model_id, evidence,
  authored_at, authored_at_precision, recorded_by)
SELECT 'projects', p.id, 'metadata.' || kv.key, 'curated_with_ai', 'authoring_with_ai_assistant',
       'nikbakht@mit.edu', 'public/bbqs_marr.yaml', left(kv.value, 500), 'gemini-3-pro',
       'Authorship stated by the author on 2026-08-19: written by Nader with Gemini 3 Pro on or about 2026-03-06.',
       '2026-03-06'::timestamptz, 'approximate',
       'migration:20260819140000'
  FROM public.projects p
 CROSS JOIN LATERAL jsonb_each_text(p.metadata) AS kv
 WHERE kv.key = ANY (public.ai_authored_metadata_keys())
   AND btrim(coalesce(kv.value, '')) <> '';

-- Verify -----------------------------------------------------------------------------------------
-- 1) Standing claims by class. Dry-run against live data predicts:
--      questionnaire            785   (683 recovered here + 102 already attributed)
--      curated_with_ai          396   (16 keys x 26 projects, Nader + Gemini 3 Pro)
--      authoritative_registry     3
--      unknown                  115   (88 of them plain columns: study_human, keywords, species)
--      TOTAL                   1299   -> 91.1% verified, from 10.9%
SELECT sc.rank, fpc.source_class, sc.is_verified, count(*) AS cells
  FROM public.field_provenance_current fpc
  JOIN public.source_classes sc ON sc.code = fpc.source_class
 GROUP BY sc.rank, fpc.source_class, sc.is_verified
 ORDER BY sc.rank, fpc.source_class;

-- 2) No form respondent is credited with the analytical layer. MUST be 0.
SELECT count(*) AS marr_misattributed_must_be_0
  FROM public.field_provenance_current
 WHERE source_class = 'questionnaire'
   AND regexp_replace(entity_column, '^metadata\.', '') = ANY (public.ai_authored_metadata_keys());

-- 3) Per-project questionnaire attribution, with respondent and submission date.
SELECT p.grant_number, fpc.agent_label AS respondent,
       min(fpc.authored_at)::date AS submitted, count(*) AS fields
  FROM public.field_provenance_current fpc
  JOIN public.projects p ON p.id = fpc.entity_id
 WHERE fpc.source_class = 'questionnaire'
 GROUP BY p.grant_number, fpc.agent_label
 ORDER BY p.grant_number;

-- 4) History intact: superseded claims are still present, not overwritten.
SELECT entity_column, count(*) AS claims_recorded
  FROM public.field_provenance
 WHERE entity_column = 'metadata.marr_l1_ethological_goal'
 GROUP BY entity_column;

-- 5) The headline: how much of what the site renders is now human- or registry-backed. Expect about
--    1184 verified / 115 unverified (91.1%). What remains is mostly the plain columns -- study_human,
--    keywords, study_species -- which no source has ever claimed.
SELECT count(*) FILTER (WHERE is_verified)     AS verified_cells,
       count(*) FILTER (WHERE NOT is_verified) AS unverified_cells,
       round(100.0 * count(*) FILTER (WHERE is_verified) / nullif(count(*), 0), 1) AS pct_verified
  FROM public.field_provenance_current
 WHERE entity_table = 'projects';
