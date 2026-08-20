-- Add a grade for algorithmic derivation, and date the two questionnaire imports that lacked it.
-- Constitution v1.8.x Principle XI.
--
-- WHY A NEW CLASS. suggest-related computes related_project_ids by field-overlap scoring: no model,
-- no prose, just a rule over KG data. It was declaring 'llm_extract' because that was the only
-- machine-and-unverified class available, which is a lie in the record -- someone reading the
-- provenance would go looking for a model that was never involved.
--
-- WHERE IT SITS, and why above llm_extract. Both are machine-produced and neither is verified, so
-- the ordering between them is about RE-CHECKABILITY, which the constitution already treats as the
-- thing that makes a machine claim usable at all ("the model id is what makes a later re-check
-- possible"). An algorithm can be re-run and its rule read; an LLM's output cannot be reproduced
-- exactly even with the same prompt. So a computed value is better evidence than a generated one.
--
-- THIS SHIFTS THE TAIL BY ONE. unknown was G7 and is now G8. That is a direct consequence of
-- inserting a class above llm_extract rather than a change of mind about absence-of-record being
-- last; nothing may sit below "no record at all", and it still does not:
--
--   G1  authoritative_registry           NIH RePORTER: the funder's own record
--   G2  questionnaire                    the project's own people, named respondent
--   G3  subject_edit                     someone editing their own record
--   G4  curator_fill, curated_with_ai    a person taking responsibility, with or without a model
--   G5  algorithmic                      computed by a rule that can be read and re-run   <-- NEW
--   G6  llm_extract                      model output; not reproducible
--   G7  web_search                       retrieved from somewhere, but unattributable
--   G8  unknown                          no record at all
--
-- G1-G4 remain is_verified: a person or a registry stands behind them.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260820140000');

-- ── 1. Make room, then insert ────────────────────────────────────────────────────────────────
-- Shift the machine tail down one before adding G5, so no two codes collide on a grade mid-way.
UPDATE public.source_classes SET grade = 8 WHERE code = 'unknown';
UPDATE public.source_classes SET grade = 7 WHERE code = 'web_search';
UPDATE public.source_classes SET grade = 6 WHERE code = 'llm_extract';

INSERT INTO public.source_classes (code, grade, label, agent_kind, is_verified, description) VALUES
  ('algorithmic', 5, 'Computed', 'machine', false,
   'Derived by a deterministic rule over data already in the graph -- similarity scoring, roll-ups, normalisation. Machine-produced and unverified, but strictly better evidence than a model''s output because the rule can be read and re-run. Record the function or script in source_ref so it can be.')
ON CONFLICT (code) DO UPDATE
  SET grade = excluded.grade, label = excluded.label, agent_kind = excluded.agent_kind,
      is_verified = excluded.is_verified, description = excluded.description;

COMMENT ON COLUMN public.source_classes.grade IS
  'Reliability grade G1 (best) to G8 (worst). A GRADE, never a tier: "tier" is the four-level user access model (admin/curator/member/public) and the numbers overlapped with opposite meanings. code is the primary key, not grade, because curator_fill and curated_with_ai legitimately share G4.';
COMMENT ON TABLE public.source_classes IS
  'Constitution XI reliability ladder: information sources graded G1 (authoritative registry) to G8 (no record at all). Data rather than an enum so the ordering is queryable and enforcement is a grade comparison.';

-- ── 2. An unrecheckable machine claim is refused, whichever kind it is ───────────────────────
-- llm_extract already had to name its model. algorithmic must name its rule, for the same reason:
-- "a machine did it" is not provenance if nobody can find out which machine or re-run it.
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
    RAISE EXCEPTION 'Unknown source class %. Valid: %', _source_class,
      (SELECT string_agg(format('G%s %s', grade, code), ', ' ORDER BY grade, code)
         FROM public.source_classes);
  END IF;

  IF _source_class = 'llm_extract' AND coalesce(btrim(_model_id), '') = '' THEN
    RAISE EXCEPTION 'llm_extract provenance requires _model_id so the claim can be re-checked.';
  END IF;

  IF _source_class = 'algorithmic' AND coalesce(btrim(_source_ref), '') = '' THEN
    RAISE EXCEPTION 'algorithmic provenance requires _source_ref naming the rule (function, script, or migration) so it can be re-run.';
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

-- ── 3. Date the two questionnaire imports that had no authored_at ────────────────────────────
-- 92 cells: 54 for Wilbrecht (R34DA062119), 38 for Ghuman (R61MH138967). They were recorded by
-- 20260819130000, which ran before authored_at existed, so the submission date was lost even though
-- it sits in metadata.questionnaire_submitted_at on the same row.
--
-- APPEND, do not UPDATE. field_provenance is append-only and its trigger refuses UPDATE outright, so
-- the correction is a NEW claim that supersedes by being newer. That is the design working, not a
-- workaround: the undated claim stays visible, and "we learned the date later" is itself a fact
-- about the record.
--
-- The date is read from the row rather than typed in here, so it cannot drift from the value the
-- import recorded.
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, evidence,
  authored_at, authored_at_precision, recorded_by)
SELECT fpc.entity_table, fpc.entity_id, fpc.entity_column, 'questionnaire', 'google_form_response',
       fpc.agent_label,
       coalesce(fpc.source_ref, 'Google Form response sheet 1L-S0573a4sS3iDanucQHMeSypmffP6Qm9kwgX7zOzn8'),
       fpc.value_text,
       'Re-recorded to carry the submission date, which metadata.questionnaire_submitted_at held all along; the original claim predates the authored_at column.',
       (p.metadata ->> 'questionnaire_submitted_at')::timestamptz,
       'exact',
       'migration:20260820140000'
  FROM public.field_provenance_current fpc
  JOIN public.projects p ON p.id = fpc.entity_id
 WHERE fpc.entity_table = 'projects'
   AND fpc.source_class = 'questionnaire'
   AND fpc.authored_at IS NULL
   AND nullif(p.metadata ->> 'questionnaire_submitted_at', '') IS NOT NULL;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) The ladder, G1..G8, with the new class at G5.
SELECT 'G' || grade AS grade, code, label, is_verified
  FROM public.source_classes ORDER BY grade, code;

-- 2) No questionnaire claim is undated any more. Expect 0.
SELECT count(*) AS undated_questionnaire_claims_should_be_0
  FROM public.field_provenance_current
 WHERE source_class = 'questionnaire' AND authored_at IS NULL;

-- 3) Per respondent, with the date now attached. Expect Wilbrecht 2025-12-10 and Ghuman 2026-06-26
--    alongside the seventeen April respondents.
SELECT p.grant_number, fpc.agent_label AS respondent,
       min(fpc.authored_at)::date AS submitted, count(*) AS fields
  FROM public.field_provenance_current fpc
  JOIN public.projects p ON p.id = fpc.entity_id
 WHERE fpc.source_class = 'questionnaire'
 GROUP BY p.grant_number, fpc.agent_label
 ORDER BY submitted DESC NULLS LAST;

-- 4) History intact: the superseded undated claims are still there. Expect 2 claims on a cell that
--    was re-recorded.
SELECT count(*) AS claims
  FROM public.field_provenance
 WHERE entity_table = 'projects'
   AND entity_column = 'metadata.help_needed'
   AND entity_id = (SELECT id FROM public.projects WHERE grant_number = 'R34DA062119');

-- 5) The new class refuses a claim nobody could re-run. MUST raise; uncomment to prove.
--   SELECT public.record_field_provenance('projects',
--            (SELECT id FROM public.projects WHERE grant_number = 'R34DA059507'),
--            'study_species', 'algorithmic', 'similarity_scoring');
