-- Per-field provenance: for every cell, who set it and how much that source can be trusted.
-- Feature 012 P1. Constitution v1.8.0 Principles X and XI.
--
-- WHY. data_audit_log already answers "what changed, by whom, when". It cannot answer "is the value
-- sitting here now trustworthy", because the audit row records an operation, not a source. That gap
-- is what let projects.study_species hold Taeniopygia guttata for R34DA059507 when the grant
-- abstract names Molothrus ater: a wrong species, generated, displayed as fact, indistinguishable
-- on screen from a curated one. The two stores are complementary -- audit is the history, this is
-- the standing claim about the current value.
--
-- THE LADDER is data, not an enum, so it can be queried, joined and ordered. Enforcement (P4) is
-- then a numeric comparison of source_classes.rank rather than a hand-maintained CASE. Two codes
-- deliberately share rank 6: web_search and unknown. They are different situations -- one retrieved
-- something unattributable, the other has no record at all -- and neither is fact. Principle XI
-- says an unrecorded field is tier 6, so "unknown" must be RECORDABLE; a NULL cannot be rendered
-- as a warning in the UI, and invisible doubt is the whole problem this feature exists to fix.
--
-- APPEND-ONLY, enforced by trigger. There is no superseded_at, because maintaining one requires
-- UPDATEs on an append-only table. The current claim is simply the newest row per cell, which
-- field_provenance_current derives with DISTINCT ON.
--
-- entity_column addresses a cell, and may be a JSON path: 'study_species' names a column,
-- 'metadata.marr_l1_ethological_goal' names one key inside the JSONB blob. Most of what the site
-- renders for a project lives in that blob (92 distinct keys across 31 projects), so per-COLUMN
-- provenance would collapse 41 separately-sourced answers into one verdict and tell nobody
-- anything.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260819130000');

-- ── 1. The hierarchy ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.source_classes (
  code        text PRIMARY KEY,
  rank        int  NOT NULL,
  label       text NOT NULL,
  agent_kind  text NOT NULL CHECK (agent_kind IN ('human', 'machine', 'external_registry')),
  is_verified boolean NOT NULL,
  description text
);

COMMENT ON TABLE public.source_classes IS
  'Constitution XI reliability ladder, lowest rank = most reliable. Data rather than an enum so the ordering is queryable and P4 enforcement is a rank comparison. code is the key, not rank, because web_search and unknown are both rank 6 and equally untrustworthy.';
COMMENT ON COLUMN public.source_classes.is_verified IS
  'True when a human or an authoritative registry stands behind the value (ranks 1-4). Drives the machine-generated marker in the UI: NOT is_verified must be visibly distinct on screen.';

INSERT INTO public.source_classes (code, rank, label, agent_kind, is_verified, description) VALUES
  ('authoritative_registry', 1, 'NIH RePORTER',        'external_registry', true,
   'An authoritative external registry: the record of record. Quote the source text as evidence.'),
  ('questionnaire',          2, 'Questionnaire',        'human',            true,
   'A form response from the project''s own people, attributed to a named respondent.'),
  ('subject_edit',           3, 'Own edit',             'human',            true,
   'The subject editing their own profile or project.'),
  ('curator_fill',           4, 'Curated',              'human',            true,
   'Hand-filled by an admin or curator.'),
  ('llm_extract',            5, 'Machine-extracted',    'machine',          false,
   'Extracted by a model from publications, abstracts or grant text. Record model_id.'),
  ('web_search',             6, 'Web search',           'machine',          false,
   'Web search or other unattributed retrieval.'),
  ('unknown',                6, 'No recorded source',   'machine',          false,
   'Predates provenance tracking, or was written by a path that recorded nothing. Not fact.')
ON CONFLICT (code) DO UPDATE
  SET rank = excluded.rank, label = excluded.label, agent_kind = excluded.agent_kind,
      is_verified = excluded.is_verified, description = excluded.description;

CREATE INDEX IF NOT EXISTS idx_source_classes_rank ON public.source_classes (rank);

-- ── 2. The claims ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.field_provenance (
  id            bigserial PRIMARY KEY,
  entity_table  text NOT NULL,
  entity_id     uuid NOT NULL,
  entity_column text NOT NULL,
  source_class  text NOT NULL REFERENCES public.source_classes(code),
  activity      text NOT NULL,
  agent_id      uuid,
  agent_label   text NOT NULL,
  source_ref    text,
  value_text    text,
  evidence      text,
  model_id      text,
  confidence    numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  recorded_by   text NOT NULL DEFAULT public.current_actor_via()
);

COMMENT ON TABLE public.field_provenance IS
  'Append-only per-cell provenance: PROV entity (entity_table/entity_id/entity_column), activity, agent (agent_id/agent_label/source_classes.agent_kind), plus the source reference and supporting evidence. The current claim for a cell is the newest row; see field_provenance_current.';
COMMENT ON COLUMN public.field_provenance.entity_column IS
  'Column name, or a JSON path into a JSONB column (metadata.marr_l1_ethological_goal). JSONB keys need addressing individually because most rendered project content lives in metadata.';
COMMENT ON COLUMN public.field_provenance.evidence IS
  'Verbatim source text supporting the claim -- the abstract sentence naming the species, for instance. Lets a human verify a registry claim at a glance instead of trusting an extractor.';
COMMENT ON COLUMN public.field_provenance.value_text IS
  'The value as written, so a later dispute can tell whether the cell still holds what this row describes.';

CREATE INDEX IF NOT EXISTS idx_field_prov_cell
  ON public.field_provenance (entity_table, entity_id, entity_column, recorded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_field_prov_class ON public.field_provenance (source_class);

/** Append-only. Provenance that can be rewritten is not provenance -- the point is that a wrong
 *  claim stays visible next to the correction. New information means a NEW row. */
CREATE OR REPLACE FUNCTION public.field_provenance_is_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'field_provenance is append-only: % is not allowed. Record a new row instead; the current claim is the newest one.',
    TG_OP;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_field_provenance_append_only ON public.field_provenance;
CREATE TRIGGER trg_field_provenance_append_only
  BEFORE UPDATE OR DELETE ON public.field_provenance
  FOR EACH ROW EXECUTE FUNCTION public.field_provenance_is_append_only();

-- ── 3. The current claim per cell ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.field_provenance_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (fp.entity_table, fp.entity_id, fp.entity_column)
       fp.entity_table,
       fp.entity_id,
       fp.entity_column,
       fp.source_class,
       sc.rank        AS source_rank,
       sc.label       AS source_label,
       sc.agent_kind,
       sc.is_verified,
       fp.activity,
       fp.agent_id,
       fp.agent_label,
       fp.source_ref,
       fp.value_text,
       fp.evidence,
       fp.model_id,
       fp.confidence,
       fp.recorded_at,
       fp.recorded_by,
       -- How many times this cell's source has been restated or revised. A cell whose provenance
       -- has churned is worth a curator's attention even when the newest claim looks fine.
       (SELECT count(*) FROM public.field_provenance p2
         WHERE p2.entity_table = fp.entity_table
           AND p2.entity_id = fp.entity_id
           AND p2.entity_column = fp.entity_column) AS claim_count
  FROM public.field_provenance fp
  JOIN public.source_classes sc ON sc.code = fp.source_class
 ORDER BY fp.entity_table, fp.entity_id, fp.entity_column, fp.recorded_at DESC, fp.id DESC;

COMMENT ON VIEW public.field_provenance_current IS
  'The standing provenance claim for each cell: newest row per (table, id, column), joined to its rank and is_verified. This is what the UI reads -- is_verified false must render as machine-generated.';

-- ── 4. Recording helper ───────────────────────────────────────────────────────────────────────
/** The only intended write path. SECURITY DEFINER so callers need no direct INSERT on an
 *  append-only table, and so agent_kind always comes from the ladder rather than the caller's
 *  opinion of it. */
CREATE OR REPLACE FUNCTION public.record_field_provenance(
  _table        text,
  _id           uuid,
  _column       text,
  _source_class text,
  _activity     text,
  _agent_label  text DEFAULT NULL,
  _source_ref   text DEFAULT NULL,
  _value        text DEFAULT NULL,
  _evidence     text DEFAULT NULL,
  _model_id     text DEFAULT NULL,
  _confidence   numeric DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _new_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.source_classes WHERE code = _source_class) THEN
    RAISE EXCEPTION 'Unknown source_class %. Valid: %',
      _source_class, (SELECT string_agg(code, ', ' ORDER BY rank, code) FROM public.source_classes);
  END IF;

  -- A machine claim without a model id is unauditable: nobody can later ask which model, or
  -- re-run it. Refuse rather than accept a claim that cannot be checked.
  IF _source_class = 'llm_extract' AND coalesce(btrim(_model_id), '') = '' THEN
    RAISE EXCEPTION 'llm_extract provenance requires _model_id so the claim can be re-checked.';
  END IF;

  INSERT INTO public.field_provenance (
    entity_table, entity_id, entity_column, source_class, activity,
    agent_id, agent_label, source_ref, value_text, evidence, model_id, confidence)
  VALUES (
    _table, _id, _column, _source_class, _activity,
    auth.uid(),
    coalesce(nullif(btrim(_agent_label), ''), public.current_actor_via()),
    _source_ref, _value, _evidence, _model_id, _confidence)
  RETURNING id INTO _new_id;

  RETURN _new_id;
END;
$fn$;

COMMENT ON FUNCTION public.record_field_provenance IS
  'Record the source of one cell. agent_kind is derived from source_classes, agent_id from auth.uid(), and agent_label falls back to the set_actor() label. Refuses an unknown source_class, and refuses llm_extract without a model id.';

-- ── 5. Access ─────────────────────────────────────────────────────────────────────────────────
-- Admins and curators only for now: the user's instruction was that this need not be visible to
-- every member yet, and provenance rows carry submitter emails.
ALTER TABLE public.field_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_classes   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff read field provenance" ON public.field_provenance;
CREATE POLICY "staff read field provenance" ON public.field_provenance
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator'));

-- The ladder itself is not sensitive, and the UI needs its labels to render a marker.
DROP POLICY IF EXISTS "anyone signed in reads the ladder" ON public.source_classes;
CREATE POLICY "anyone signed in reads the ladder" ON public.source_classes
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.source_classes, public.field_provenance, public.field_provenance_current
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_field_provenance TO authenticated, service_role;

-- ── 6. Backfill what is actually knowable ─────────────────────────────────────────────────────
-- Honesty over coverage. Only three sources can be evidenced today, and everything else is
-- recorded as 'unknown' rather than quietly assumed to be curated. That will look bad on screen.
-- It is the true state, and Principle XI requires showing it rather than implying verification.

-- (a) Tier 1: the species corrected from the grant abstract in 20260819120000. Reads the stanza
--     that migration wrote, so this is a no-op when P5 has not been applied yet -- migrations must
--     degrade gracefully rather than assume a sibling landed first.
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, evidence, recorded_by)
SELECT 'projects', p.id, 'study_species', 'authoritative_registry', 'reporter_abstract_quote',
       coalesce(s ->> 'agent_label', 'NIH RePORTER'),
       s ->> 'source_ref',
       array_to_string(p.study_species, ', '),
       s ->> 'evidence',
       'migration:20260819130000'
  FROM public.projects p
 CROSS JOIN LATERAL (SELECT p.metadata -> 'field_provenance' -> 'study_species') AS x(s)
 WHERE s IS NOT NULL
   AND s ->> 'source_class' = '1'
   AND NOT EXISTS (
     SELECT 1 FROM public.field_provenance fp
      WHERE fp.entity_table = 'projects' AND fp.entity_id = p.id
        AND fp.entity_column = 'study_species'
        AND fp.source_class = 'authoritative_registry');

-- (b) Tier 2: every questionnaire answer, attributed to the person who submitted the form. This is
--     the only genuinely well-sourced bulk data in the KG -- two projects, but per FIELD, which is
--     the granularity the feature is about. Bookkeeping keys are excluded: they describe the
--     submission, they are not answers.
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, recorded_by)
SELECT 'projects', p.id, 'metadata.' || kv.key, 'questionnaire', 'google_form_response',
       p.metadata ->> 'questionnaire_submitted_by',
       p.metadata ->> 'questionnaire_response_id',
       left(kv.value, 500),
       'migration:20260819130000'
  FROM public.projects p
 CROSS JOIN LATERAL jsonb_each_text(p.metadata) AS kv
 WHERE p.metadata ->> 'questionnaire_submitted_by' IS NOT NULL
   AND kv.key NOT IN ('questionnaire_submitted_by', 'questionnaire_submitted_at',
                      'questionnaire_response_id', 'field_provenance')
   AND btrim(coalesce(kv.value, '')) <> ''
   AND NOT EXISTS (
     SELECT 1 FROM public.field_provenance fp
      WHERE fp.entity_table = 'projects' AND fp.entity_id = p.id
        AND fp.entity_column = 'metadata.' || kv.key);

-- (c) Everything else that is rendered: recorded as having no known source. Deliberately narrow --
--     the columns the site actually shows for a project -- because stamping every column of every
--     table 'unknown' would produce noise nobody reads instead of a signal somebody acts on.
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, value_text, recorded_by)
SELECT 'projects', p.id, c.col, 'unknown', 'backfill',
       coalesce(p.last_edited_by::text, 'predates-provenance'),
       left(c.val, 500),
       'migration:20260819130000'
  FROM public.projects p
 CROSS JOIN LATERAL (VALUES
     ('study_species', array_to_string(p.study_species, ', ')),
     ('study_human',   p.study_human::text),
     ('website',       p.website),
     ('keywords',      array_to_string(p.keywords, ', '))
   ) AS c(col, val)
 WHERE btrim(coalesce(c.val, '')) <> ''
   AND NOT EXISTS (
     SELECT 1 FROM public.field_provenance fp
      WHERE fp.entity_table = 'projects' AND fp.entity_id = p.id AND fp.entity_column = c.col);

-- (d) The Marr-layer prose in metadata, for projects with no questionnaire attribution. This is the
--     text the diagram pages render, and it came out of bbqs_marr.yaml, whose header claims it was
--     "strictly audited" -- a claim the species audit disproved for the same file. Recording it as
--     unknown rather than llm_extract is the honest call: nobody can now prove which model or
--     person wrote it, and record_field_provenance would rightly refuse llm_extract with no model.
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, value_text, recorded_by)
SELECT 'projects', p.id, 'metadata.' || kv.key, 'unknown', 'backfill',
       'predates-provenance', left(kv.value, 500), 'migration:20260819130000'
  FROM public.projects p
 CROSS JOIN LATERAL jsonb_each_text(p.metadata) AS kv
 WHERE p.metadata ->> 'questionnaire_submitted_by' IS NULL
   AND kv.key <> 'field_provenance'
   AND btrim(coalesce(kv.value, '')) <> ''
   AND NOT EXISTS (
     SELECT 1 FROM public.field_provenance fp
      WHERE fp.entity_table = 'projects' AND fp.entity_id = p.id
        AND fp.entity_column = 'metadata.' || kv.key);

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Standing claims by tier. Expect authoritative_registry = 3 (0 if P5 is not applied yet),
--    questionnaire in the high tens (two projects x ~40 answers), the rest unknown.
SELECT sc.rank, fpc.source_class, sc.is_verified, count(*) AS cells
  FROM public.field_provenance_current fpc
  JOIN public.source_classes sc ON sc.code = fpc.source_class
 GROUP BY sc.rank, fpc.source_class, sc.is_verified
 ORDER BY sc.rank, fpc.source_class;

-- 2) The species cells, best claim first. The three corrected rows should show tier 1 WITH the
--    abstract sentence; every other project should show 'unknown'.
SELECT p.grant_number,
       fpc.source_class,
       fpc.is_verified,
       fpc.value_text,
       left(coalesce(fpc.evidence, ''), 60) AS evidence
  FROM public.field_provenance_current fpc
  JOIN public.projects p ON p.id = fpc.entity_id
 WHERE fpc.entity_table = 'projects' AND fpc.entity_column = 'study_species'
 ORDER BY fpc.source_rank, p.grant_number;

-- 3) Per-field questionnaire attribution really is per FIELD, not per row.
SELECT p.grant_number, fpc.agent_label, count(*) AS fields_attributed
  FROM public.field_provenance_current fpc
  JOIN public.projects p ON p.id = fpc.entity_id
 WHERE fpc.source_class = 'questionnaire'
 GROUP BY p.grant_number, fpc.agent_label
 ORDER BY p.grant_number;

-- 4) Append-only actually holds. Both statements MUST raise; if either succeeds the trigger is
--    not doing its job and provenance can be rewritten.
--   UPDATE public.field_provenance SET value_text = 'tampered' WHERE id = (SELECT min(id) FROM public.field_provenance);
--   DELETE FROM public.field_provenance WHERE id = (SELECT min(id) FROM public.field_provenance);

-- 5) How much of what the site renders is unverified. This is the number to drive down, and the
--    honest headline: today it should be almost everything.
SELECT count(*) FILTER (WHERE is_verified)       AS verified_cells,
       count(*) FILTER (WHERE NOT is_verified)   AS unverified_cells,
       round(100.0 * count(*) FILTER (WHERE is_verified) / nullif(count(*), 0), 1) AS pct_verified
  FROM public.field_provenance_current
 WHERE entity_table = 'projects';
