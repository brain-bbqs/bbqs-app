-- Enforce the source hierarchy: a machine may not silently overwrite what a human or a registry
-- established. Feature 012 P4. Constitution v1.8.1 Principle XI.
--
-- WHAT THIS STOPS. The species audit found the KG asserting Taeniopygia guttata for a grant whose
-- abstract names Molothrus ater. Nothing prevented a generated value from landing on a curated field,
-- and nothing recorded that it had. This makes the first case an error and the second automatic.
--
-- THE RULE, AND ITS DELIBERATE NARROWING. Principle XI says a lower grade must not silently
-- overwrite a higher one. Read literally that would block an admin (G4, curator_fill) from fixing a
-- typo in a questionnaire answer (G2) -- and on some projects 72 of the fields are G2, so the console
-- would become unusable for exactly the people responsible for the data. The principle names the
-- case it cares about: a G5 extraction landing on a field already held at G1-G3. So the hard gate
-- is MACHINE-OVER-HUMAN:
--
--     refuse when the incoming source is not verified (G5-G7) and the standing claim IS verified.
--
-- A human overriding another human is allowed and RECORDED, which is the honest outcome: you can see
-- that a curator overrode a form answer, who did it and when, and argue about it with evidence. A
-- machine overriding a person is refused outright, because that is the failure that produced a wrong
-- species nobody could see.
--
-- EVERY WRITE IS NOW SELF-DOCUMENTING. The same trigger records provenance for each changed cell, so
-- the store stays true without any call site remembering to log. Principle X says no written value
-- may be unattributable; relying on writers to volunteer that has already failed once -- last_edited_by
-- held the questionnaire respondents until one later write erased all seventeen of them.
--
-- HOW A WRITER DECLARES ITS CLASS, in resolution order:
--   1. set_source_class('authoritative_registry')  -- transaction-local; for migrations and SQL
--   2. request header x-bbqs-source-class          -- for edge functions (see suggest-related), set on
--                                                     their OWN server-side
--                                                     client. NOT a global browser header: adding one
--                                                     of those broke every edge function's CORS
--                                                     allow-list once already, and tests/guards/
--                                                     cors-header-parity.test.mjs now watches for it.
--   3. a signed-in user with no declaration        -> curator_fill (G4). A person editing through
--                                                     the console genuinely IS a hand-curated fill,
--                                                     and this is what keeps ProjectProfile working
--                                                     without touching its save path.
--   4. anything else (service role, cron, SQL editor) -> unknown (G7), which cannot overwrite
--                                                     verified data. Machines must say who they are.
--
-- WRITERS ENUMERATED before shipping (the shared-layer checklist in CLAUDE.md):
--   ProjectProfile.commit()   browser upsert of study_species/study_human/website/keywords + metadata.
--                             Signed-in -> G4. Unaffected except that it now records provenance.
--   nih-grants                INSERTs a bare {grant_number, grant_id} row only when none exists, and
--                             never UPDATEs a tracked column. Runs on every /projects visit, so this
--                             was the one that had to be checked: it is untouched by an UPDATE guard.
--   add-project-by-grant      NOT a writer of tracked columns. An earlier draft of this header said
--                             it was and told the reader to add a header it does not need. That came
--                             from grepping for column names and matching its SELECT list (line 193);
--                             all eight of its writes go to grants / resources / organizations /
--                             investigators / investigator_organizations, plus a bare
--                             {grant_number, grant_id} INSERT into projects. It returns early when a
--                             project already exists and never UPDATEs one.
--   suggest-related           THE real machine writer: UPDATEs projects.metadata to extend
--                             related_project_ids. That key is curated_with_ai (Nader + Gemini 3 Pro),
--                             so an undeclared service-role write is refused -- which is the point. It
--                             now declares x-bbqs-source-class and, crucially, READS the error: the
--                             write was previously unchecked, so a refusal would have been swallowed
--                             and still reported as updated:true. Silent success on a rejected write
--                             is worse than the overwrite this guard exists to stop.
--   useMetadataEditor.ts      client UPDATE of projects.metadata by a signed-in user -> curator_fill,
--                             verified, allowed. Unaffected.
--   ProjectProfile.commit()   same, via upsert.
--   embed-knowledge, import-grant-publications
--                             read these columns; their writes go to other tables. Unaffected.
--   seed-staging-fakes        staging only.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260820120000');

-- -- 0. Vocabulary: information sources have a GRADE, users have a TIER ------------------------
-- "Tier" was already taken. useUserTier.ts defines a four-level ACCESS model -- admin, curator,
-- member, public -- so calling the reliability ladder tiers collided on both the word and the
-- numbers, and meant opposite things across the two: curator_fill is information 4 while curator is
-- user 2, and "tier 2" meant questionnaire in one sentence and curator in the next.
--
-- Information sources are now GRADES, written G1..G7. A grade cannot be mistaken for a tier in
-- speech, in a commit message, or in a refusal string:
--
--   G1  authoritative_registry           NIH RePORTER: the funder's own record
--   G2  questionnaire                    the project's own people, named respondent
--   G3  subject_edit                     someone editing their own record
--   G4  curator_fill, curated_with_ai    a person typing a value, with or without a model
--   G5  llm_extract                      machine-produced from text
--   G6  web_search                       retrieved from somewhere, but unattributed
--   G7  unknown                          no record at all
--
-- G1-G4 are is_verified: a person or a registry stands behind them.
--
-- SEVEN grades, not six. An earlier draft put web_search and unknown together on the reasoning that
-- "neither is fact", which is true but flattens a real difference: a web-sourced value HAS a trail,
-- however weak -- somebody retrieved something from somewhere -- while "no record at all" is the
-- absence of one. No-record is strictly worse and gets its own grade, which also makes the ladder
-- one-code-per-grade the whole way down apart from G4, where curator_fill and curated_with_ai are
-- both a person taking responsibility and are told apart by the model id and the UI treatment
-- rather than by reliability.
--
-- RENAMING rather than adding a column: Postgres rewrites dependent view definitions by attribute
-- number, so field_provenance_current survives the rename. Its OUTPUT column needs renaming
-- separately, which ALTER VIEW does directly -- CREATE OR REPLACE VIEW cannot rename a column and
-- would fail with 42P16.
--
-- Migrations 20260819130000 and 20260819140000 are already applied and say "rank" and "tier" in
-- their comments. They are a ledger of what happened, so they are left alone; this is the
-- forwarding address.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'source_classes'
                AND column_name = 'rank') THEN
    ALTER TABLE public.source_classes RENAME COLUMN rank TO grade;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'field_provenance_current'
                AND column_name = 'source_rank') THEN
    ALTER VIEW public.field_provenance_current RENAME COLUMN source_rank TO source_grade;
  END IF;
END
$do$;

ALTER INDEX IF EXISTS idx_source_classes_rank RENAME TO idx_source_classes_grade;

-- 'unknown' shipped at grade 6 alongside web_search. Separate them: absence of a record is worse
-- than a weak record, and a ladder with one code per grade is easier to reason about.
UPDATE public.source_classes
   SET grade = 7,
       label = 'No recorded source',
       description = 'No provenance was ever recorded: the value predates tracking, or was written by a path that logged nothing. Strictly worse than web_search, which at least had a source. Not fact.'
 WHERE code = 'unknown';

COMMENT ON COLUMN public.source_classes.grade IS
  'Reliability grade G1 (best) to G7 (worst). A GRADE, never a tier: "tier" is the four-level user access model (admin/curator/member/public) and the numbers overlapped with opposite meanings. code is the primary key, not grade, because curator_fill and curated_with_ai legitimately share G4.';
COMMENT ON TABLE public.source_classes IS
  'Constitution XI reliability ladder: information sources graded G1 (authoritative registry) to G7 (no record at all). Data rather than an enum so the ordering is queryable and enforcement is a grade comparison.';
COMMENT ON COLUMN public.source_classes.is_verified IS
  'True for G1-G4: a human or an authoritative registry stands behind the value. Drives the machine-generated marker in the UI -- NOT is_verified must be visibly distinct on screen.';

-- record_field_provenance listed the valid classes ordered by rank; it now names their grades.
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
-- This migration corrects data provenance by hand, which is what a curator does.
-- Declaring it keeps the migration itself honest under its own rule.

CREATE OR REPLACE FUNCTION public.set_source_class(_code text)
RETURNS text LANGUAGE sql VOLATILE AS $fn$
  SELECT set_config('app.source_class', coalesce(nullif(btrim(_code), ''), ''), true)
$fn$;

COMMENT ON FUNCTION public.set_source_class(text) IS
  'Declares the Principle XI source class for the current transaction, for writes where no request header is available (migrations, SQL editor, SECURITY DEFINER functions). Transaction-local, like set_actor: it must be re-declared per transaction so a stale declaration cannot be inherited by unrelated later work.';

GRANT EXECUTE ON FUNCTION public.set_source_class(text) TO authenticated, service_role;

/** Which source class the current write should be attributed to. Mirrors current_actor_via(). */
CREATE OR REPLACE FUNCTION public.current_source_class()
RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(
    (SELECT sc.code FROM public.source_classes sc
      WHERE sc.code = nullif(current_setting('app.source_class', true), '')),
    (SELECT sc.code FROM public.source_classes sc
      WHERE sc.code = nullif(current_setting('request.headers', true)::jsonb ->> 'x-bbqs-source-class', '')),
    -- A person at a keyboard is a hand-curated fill. Anything else must have declared itself.
    CASE WHEN auth.uid() IS NOT NULL THEN 'curator_fill' END,
    'unknown'
  )
$fn$;

COMMENT ON FUNCTION public.current_source_class() IS
  'Resolves the source class for the current write: set_source_class(), then the x-bbqs-source-class request header, then curator_fill for any signed-in user, else unknown. An undeclared machine write is therefore G7 and cannot overwrite verified data -- it fails safe by construction.';

GRANT EXECUTE ON FUNCTION public.current_source_class() TO authenticated, service_role;

/** The columns this guard watches on `projects`. Plain columns plus every key inside metadata. */
CREATE OR REPLACE FUNCTION public.provenance_tracked_columns()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY['study_species', 'study_human', 'website', 'keywords']::text[]
$fn$;

COMMENT ON FUNCTION public.provenance_tracked_columns() IS
  'Plain columns on projects that the provenance guard watches. Every key inside metadata is watched too, individually.';

GRANT EXECUTE ON FUNCTION public.provenance_tracked_columns() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_field_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _class     text := public.current_source_class();
  _verified  boolean;
  _actor     text := public.current_actor_via();
  _col       text;
  _old       text;
  _new       text;
  _cur_ok    boolean;   -- is the STANDING claim verified?
  _cur_label text;
  _cur_agent text;
  _kv        record;
  -- to_jsonb rather than dynamic SQL: `EXECUTE 'SELECT ($1).' || col USING OLD` cannot resolve a
  -- field of a record-typed parameter (the planner has no composite type for $1). Casting the rows
  -- to jsonb once gives keyed access to every column with no EXECUTE at all.
  _oldj      jsonb := to_jsonb(OLD);
  _newj      jsonb := to_jsonb(NEW);
BEGIN
  SELECT sc.is_verified INTO _verified
    FROM public.source_classes sc WHERE sc.code = _class;

  -- ── plain columns ───────────────────────────────────────────────────────────────────────────
  FOREACH _col IN ARRAY public.provenance_tracked_columns() LOOP
    _old := _oldj ->> _col;
    _new := _newj ->> _col;

    CONTINUE WHEN _old IS NOT DISTINCT FROM _new;
    CONTINUE WHEN btrim(coalesce(_new, '')) = '';   -- clearing a value is Principle VI's business

    -- Straight at the table, not through field_provenance_current: the view recomputes claim_count
    -- with a correlated subquery per row, and one UPDATE can check 76 cells. This hits
    -- idx_field_prov_cell and stops at the first row.
    SELECT sc.is_verified, sc.label, fp.agent_label
      INTO _cur_ok, _cur_label, _cur_agent
      FROM public.field_provenance fp
      JOIN public.source_classes sc ON sc.code = fp.source_class
     WHERE fp.entity_table = 'projects' AND fp.entity_id = NEW.id AND fp.entity_column = _col
     ORDER BY fp.recorded_at DESC, fp.id DESC
     LIMIT 1;

    -- No standing claim leaves _cur_ok NULL, so this is false and the write proceeds: there is
    -- nothing to protect on a cell nobody has ever vouched for.
    IF _cur_ok AND NOT _verified THEN
      RAISE EXCEPTION
        'Refusing to overwrite %.% : it is held at "%"%, and this write is only "%". Declare a better source with set_source_class() or the x-bbqs-source-class header, or route the change through a human.',
        'projects', _col, _cur_label,
        coalesce(' (' || _cur_agent || ')', ''), _class
        USING ERRCODE = 'check_violation',
              HINT = 'Constitution XI: a machine may not silently overwrite a human- or registry-established value.';
    END IF;

    INSERT INTO public.field_provenance (
      entity_table, entity_id, entity_column, source_class, activity,
      agent_id, agent_label, value_text, recorded_by)
    VALUES ('projects', NEW.id, _col, _class, 'direct_write',
            auth.uid(), _actor, left(_new, 500), _actor);
  END LOOP;

  -- ── metadata, one key at a time ─────────────────────────────────────────────────────────────
  -- Per-key, not per-column: a project's metadata holds up to 72 separately-sourced answers, and one
  -- verdict for the whole blob would say nothing about any of them.
  IF NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    FOR _kv IN SELECT key, value FROM jsonb_each_text(coalesce(NEW.metadata, '{}'::jsonb)) LOOP
      CONTINUE WHEN _kv.key = 'field_provenance';
      CONTINUE WHEN (coalesce(OLD.metadata, '{}'::jsonb) ->> _kv.key) IS NOT DISTINCT FROM _kv.value;
      CONTINUE WHEN btrim(coalesce(_kv.value, '')) = '';

      SELECT sc.is_verified, sc.label, fp.agent_label
        INTO _cur_ok, _cur_label, _cur_agent
        FROM public.field_provenance fp
        JOIN public.source_classes sc ON sc.code = fp.source_class
       WHERE fp.entity_table = 'projects' AND fp.entity_id = NEW.id
         AND fp.entity_column = 'metadata.' || _kv.key
       ORDER BY fp.recorded_at DESC, fp.id DESC
       LIMIT 1;

      IF _cur_ok AND NOT _verified THEN
        RAISE EXCEPTION
          'Refusing to overwrite projects.metadata.% : it is held at "%"%, and this write is only "%".',
          _kv.key, _cur_label, coalesce(' (' || _cur_agent || ')', ''), _class
          USING ERRCODE = 'check_violation',
                HINT = 'Constitution XI: a machine may not silently overwrite a human- or registry-established value.';
      END IF;

      INSERT INTO public.field_provenance (
        entity_table, entity_id, entity_column, source_class, activity,
        agent_id, agent_label, value_text, recorded_by)
      VALUES ('projects', NEW.id, 'metadata.' || _kv.key, _class, 'direct_write',
              auth.uid(), _actor, left(_kv.value, 500), _actor);
    END LOOP;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.enforce_field_provenance() IS
  'Guards and records writes to provenance-tracked project fields. Refuses an unverified (G5-G7) write onto a cell currently held by a verified source; records provenance for every changed cell either way, so no write is unattributable. Human-over-human edits are permitted and logged -- the gate is machine-over-human.';

-- AFTER would be too late to refuse, and only UPDATE can overwrite anything, so INSERT is left to the
-- backfills: a brand-new row has nothing to protect.
DROP TRIGGER IF EXISTS trg_enforce_field_provenance ON public.projects;
CREATE TRIGGER trg_enforce_field_provenance
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_field_provenance();

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) The resolver. In the SQL editor auth.uid() is NULL and nothing is declared, so: unknown.
SELECT public.current_source_class() AS should_be_unknown;
SELECT public.set_source_class('authoritative_registry');
SELECT public.current_source_class() AS should_be_authoritative_registry;

-- 2) THE GATE, proven. Declare a machine class, then try to overwrite a G1 species. Expect
--    check_violation naming NIH RePORTER. Uncomment to run -- it is designed to FAIL.
--   SELECT public.set_source_class('llm_extract');
--   UPDATE public.projects SET study_species = ARRAY['Wrong species']::text[]
--    WHERE grant_number = 'R34DA059507';

-- 3) The permitted case: a human overriding a human is allowed, and leaves a trail. Also designed to
--    be run by hand, since it writes.
--   SELECT public.set_source_class('curator_fill');
--   UPDATE public.projects SET keywords = keywords WHERE grant_number = 'R34DA059507';

-- 4) Nothing is silently unattributable any more: every tracked column of every project either has a
--    standing claim or has never been written. Expect 0.
SELECT count(*) AS tracked_cells_without_provenance_should_be_0
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

-- 5) The ladder, for reference when reading a refusal message. Grades, not tiers.
SELECT 'G' || grade AS grade, code, label, is_verified
  FROM public.source_classes ORDER BY grade, code;
