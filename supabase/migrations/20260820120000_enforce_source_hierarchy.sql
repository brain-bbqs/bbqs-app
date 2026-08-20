-- Enforce the source hierarchy: a machine may not silently overwrite what a human or a registry
-- established. Feature 012 P4. Constitution v1.8.1 Principle XI.
--
-- WHAT THIS STOPS. The species audit found the KG asserting Taeniopygia guttata for a grant whose
-- abstract names Molothrus ater. Nothing prevented a generated value from landing on a curated field,
-- and nothing recorded that it had. This makes the first case an error and the second automatic.
--
-- THE RULE, AND ITS DELIBERATE NARROWING. Principle XI says a lower tier must not silently overwrite
-- a higher one. Read literally that would block an admin (tier 4, curator_fill) from correcting a
-- typo in a questionnaire answer (tier 2) -- and on some projects 72 of the fields are tier 2, so the
-- console would become unusable for exactly the people responsible for the data. The principle's own
-- wording names the case it cares about: "a tier-5 extraction landing on a field already held at
-- tier 1-3". So the hard gate is MACHINE-OVER-HUMAN:
--
--     refuse when the incoming source is not verified (tier 5/6) and the standing claim IS verified.
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
--   2. request header x-bbqs-source-class          -- for edge functions, set on their OWN server-side
--                                                     client. NOT a global browser header: adding one
--                                                     of those broke every edge function's CORS
--                                                     allow-list once already, and tests/guards/
--                                                     cors-header-parity.test.mjs now watches for it.
--   3. a signed-in user with no declaration        -> curator_fill (tier 4). A person editing through
--                                                     the console genuinely IS a hand-curated fill,
--                                                     and this is what keeps ProjectProfile working
--                                                     without touching its save path.
--   4. anything else (service role, cron, SQL editor) -> unknown (tier 6), which cannot overwrite
--                                                     verified data. Machines must say who they are.
--
-- WRITERS ENUMERATED before shipping (the shared-layer checklist in CLAUDE.md):
--   ProjectProfile.commit()   browser upsert of study_species/study_human/website/keywords + metadata.
--                             Signed-in -> tier 4. Unaffected except that it now records provenance.
--   nih-grants                INSERTs a bare {grant_number, grant_id} row only when none exists, and
--                             never UPDATEs a tracked column. Runs on every /projects visit, so this
--                             was the one that had to be checked: it is untouched by an UPDATE guard.
--   add-project-by-grant      writes study_species/keywords/website/metadata from RePORTER = tier 1.
--                             Runs on an admin action, not page load. Must send the header; until it
--                             does it resolves to tier 6 and will be REFUSED against verified cells,
--                             loudly, in an admin flow rather than a public page.
--   suggest-related, embed-knowledge, import-grant-publications
--                             read these columns; their writes go to other tables. Unaffected.
--   seed-staging-fakes        staging only.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260820120000');
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
  'Resolves the source class for the current write: set_source_class(), then the x-bbqs-source-class request header, then curator_fill for any signed-in user, else unknown. An undeclared machine write is therefore tier 6 and cannot overwrite verified data -- it fails safe by construction.';

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
  'Guards and records writes to provenance-tracked project fields. Refuses an unverified (tier 5/6) write onto a cell currently held by a verified source; records provenance for every changed cell either way, so no write is unattributable. Human-over-human edits are permitted and logged -- the gate is machine-over-human.';

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

-- 2) THE GATE, proven. Declare a machine class, then try to overwrite a tier-1 species. Expect
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

-- 5) The ladder, for reference when reading a refusal message.
SELECT rank, code, label, is_verified FROM public.source_classes ORDER BY rank, code;
