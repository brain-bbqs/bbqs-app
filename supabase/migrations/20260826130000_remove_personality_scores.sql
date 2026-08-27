-- Remove the personality-score project from the KG.
--
-- WHAT GOES. `personality_scores` (226 rows), every provenance claim about it (~2,566 graded cells,
-- 42% of the whole store per 20260822170000), the `/internal/coordination` page and its two
-- components, and the `personality-score-worker` edge function. Decision by the PI, 2026-08-26.
--
-- WHY THIS IS NOT A `DROP TABLE ... CASCADE`. Three live objects join the table by name, and one of
-- them is a VIEW whose column list must not change (42P16 -- CREATE OR REPLACE VIEW cannot drop or
-- reorder columns). CASCADE would silently take `provenance_worklist` with it, which is the curator
-- queue for the ENTIRE graph. So each dependent is rewritten first, then the table is dropped with a
-- plain DROP that FAILS if anything still points at it. A loud failure here is the point.
--
--   provenance_worklist    VIEW      LEFT JOIN personality_scores + investigators (for record_label)
--   provenance_activity()  FUNCTION  the same two joins
--   provenance_table_priority(text)  a string literal in a CASE -- inert after the drop, cleaned anyway
--
-- Removing the two joins does NOT change either object's column list: both feed a `coalesce(...)`
-- that resolves a record's display name, so the replacement is column-compatible.
--
-- ORDERING. This migration ships the CURRENT definition of provenance_activity(), including the
-- `_since`/`_until` window from 20260824120000. It therefore supersedes that migration and is safe
-- to apply whether or not it was run: the DROP below removes whichever older signature exists.
--
-- IRREVERSIBLE. The scores are recomputable in principle -- personality-score-worker is a
-- deterministic lexicon match -- but the worker is being deleted too. Section 0 writes both the
-- rows and their provenance to backup tables first; drop those once you are certain.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260826130000');

-- ── 0. Keep a copy, in a schema nothing reads ──────────────────────────────────────────────────
-- Cheap insurance against "actually, can we get the numbers back". Delete when you are sure:
--   DROP SCHEMA removed_personality CASCADE;
CREATE SCHEMA IF NOT EXISTS removed_personality;
CREATE TABLE IF NOT EXISTS removed_personality.personality_scores AS
  SELECT * FROM public.personality_scores;
CREATE TABLE IF NOT EXISTS removed_personality.field_provenance AS
  SELECT * FROM public.field_provenance WHERE entity_table = 'personality_scores';

-- Locked three ways, because this is a cold copy of every member's trait scores and nothing should
-- read it again. The schema is not in PostgREST's exposed list, so the API cannot reach it at all;
-- the REVOKE removes USAGE anyway; and RLS with NO POLICIES denies every non-superuser role. The
-- service role bypasses RLS, so the SQL editor can still read the backup.
REVOKE ALL ON SCHEMA removed_personality FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA removed_personality FROM PUBLIC, anon, authenticated;
ALTER TABLE removed_personality.personality_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE removed_personality.field_provenance   ENABLE ROW LEVEL SECURITY;

SELECT (SELECT count(*) FROM removed_personality.personality_scores) AS scores_backed_up,
       (SELECT count(*) FROM removed_personality.field_provenance)   AS claims_backed_up;

-- ── 1. Who still depends on the table ──────────────────────────────────────────────────────────
-- Read this before continuing. Expect exactly provenance_worklist and provenance_activity, both
-- rewritten below. Anything else means the blast radius is wider than this migration knows about.
SELECT DISTINCT dependent.relname AS depends_on_personality_scores, dependent.relkind
  FROM pg_depend d
  JOIN pg_rewrite r      ON r.oid = d.objid
  JOIN pg_class dependent ON dependent.oid = r.ev_class
 WHERE d.refobjid = 'public.personality_scores'::regclass
   AND dependent.relname <> 'personality_scores';

-- ── 2. The curator queue, without the personality joins ────────────────────────────────────────
CREATE OR REPLACE VIEW public.provenance_worklist
WITH (security_invoker = true)
AS
WITH scope AS MATERIALIZED (
  SELECT table_name FROM public.provenance_guardable_tables
), standing AS (
  SELECT DISTINCT ON (fp.entity_table, fp.entity_id, fp.entity_column)
         fp.entity_table, fp.entity_id, fp.entity_column, fp.source_class,
         fp.value_text, fp.agent_label, fp.recorded_at
    FROM public.field_provenance fp
   WHERE fp.entity_table IN (SELECT table_name FROM scope)
     AND public.provenance_is_gradable_column(fp.entity_column)
   ORDER BY fp.entity_table, fp.entity_id, fp.entity_column, fp.recorded_at DESC, fp.id DESC
)
SELECT st.entity_table,
       st.entity_id,
       st.entity_column,
       st.source_class,
       sc.grade AS source_grade,
       sc.label AS source_label,
       st.value_text,
       st.agent_label,
       st.recorded_at,
       coalesce(
         p.grant_number, i.name, g.grant_number, pub.title, o.name, sp.common_name,
         stl.name, dc.label, dm.name, dmo.model_name,
         fo.title, an.title, jb.title, res.name, pr.full_name, sa.message,
         gii.name,
         left(st.entity_id::text, 8) || '...'
       ) AS record_label,
       public.provenance_table_priority(st.entity_table) AS priority
  FROM standing st
  JOIN public.source_classes sc ON sc.code = st.source_class AND NOT sc.is_verified
  LEFT JOIN public.projects       p   ON st.entity_table = 'projects'      AND p.id   = st.entity_id
  LEFT JOIN public.investigators  i   ON st.entity_table = 'investigators' AND i.id   = st.entity_id
  LEFT JOIN public.grants         g   ON st.entity_table = 'grants'        AND g.id   = st.entity_id
  LEFT JOIN public.publications   pub ON st.entity_table = 'publications'  AND pub.id = st.entity_id
  LEFT JOIN public.organizations  o   ON st.entity_table = 'organizations' AND o.id   = st.entity_id
  LEFT JOIN public.species        sp  ON st.entity_table = 'species'       AND sp.id  = st.entity_id
  LEFT JOIN public.software_tools stl ON st.entity_table = 'software_tools'        AND stl.id = st.entity_id
  LEFT JOIN public.device_categories    dc  ON st.entity_table = 'device_categories'    AND dc.id  = st.entity_id
  LEFT JOIN public.device_manufacturers dm  ON st.entity_table = 'device_manufacturers' AND dm.id  = st.entity_id
  LEFT JOIN public.device_models        dmo ON st.entity_table = 'device_models'        AND dmo.id = st.entity_id
  LEFT JOIN public.funding_opportunities fo ON st.entity_table = 'funding_opportunities' AND fo.id = st.entity_id
  LEFT JOIN public.announcements  an  ON st.entity_table = 'announcements'  AND an.id  = st.entity_id
  LEFT JOIN public.jobs           jb  ON st.entity_table = 'jobs'           AND jb.id  = st.entity_id
  LEFT JOIN public.resources      res ON st.entity_table = 'resources'      AND res.id = st.entity_id
  LEFT JOIN public.profiles       pr  ON st.entity_table = 'profiles'       AND pr.id  = st.entity_id
  LEFT JOIN public.system_alerts  sa  ON st.entity_table = 'system_alerts'  AND sa.id  = st.entity_id
  LEFT JOIN public.grant_investigators gi ON st.entity_table = 'grant_investigators' AND gi.id = st.entity_id
  LEFT JOIN public.investigators      gii ON gii.id = gi.investigator_id;

GRANT SELECT ON public.provenance_worklist TO authenticated;

-- ── 3. The Edit log, without the personality joins ─────────────────────────────────────────────
-- Both signatures are dropped so this works whether or not 20260824120000 was applied. Adding
-- parameters creates an OVERLOAD rather than replacing, and a 2-arg call then fails as ambiguous.
DROP FUNCTION IF EXISTS public.provenance_activity(int, boolean);
DROP FUNCTION IF EXISTS public.provenance_activity(int, boolean, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.provenance_activity(
  _limit int DEFAULT 500,
  _include_backfill boolean DEFAULT false,
  _since timestamptz DEFAULT NULL,
  _until timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id bigint, recorded_at timestamptz, entity_table text, entity_id uuid, entity_column text,
  record_label text, source_class text, source_grade int, source_label text, is_verified boolean,
  activity text, agent_label text, agent_kind text, value_text text, prev_value text,
  prev_source_label text, source_ref text, recorded_by text
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $fn$
  WITH recent AS (
    SELECT fp.*
      FROM public.field_provenance fp
     WHERE (_include_backfill OR fp.activity <> 'backfill')
       AND (_since IS NULL OR fp.recorded_at >= _since)
       AND (_until IS NULL OR fp.recorded_at <= _until)
     ORDER BY fp.recorded_at DESC, fp.id DESC
     LIMIT greatest(1, least(coalesce(_limit, 500), 2000))
  )
  SELECT r.id, r.recorded_at, r.entity_table, r.entity_id, r.entity_column,
         coalesce(
           p.grant_number, i.name, g.grant_number, pub.title, o.name, sp.common_name,
           stl.name, dc.label, dm.name, dmo.model_name,
           fo.title, an.title, jb.title, res.name, pr.full_name, sa.message,
           gii.name,
           left(r.entity_id::text, 8) || '...'
         )::text AS record_label,
         r.source_class, sc.grade, sc.label, sc.is_verified, r.activity, r.agent_label,
         sc.agent_kind::text, r.value_text,
         prev.value_text, prevsc.label, r.source_ref, r.recorded_by
    FROM recent r
    JOIN public.source_classes sc ON sc.code = r.source_class
    LEFT JOIN LATERAL (
      SELECT f2.value_text, f2.source_class
        FROM public.field_provenance f2
       WHERE f2.entity_table = r.entity_table
         AND f2.entity_id    = r.entity_id
         AND f2.entity_column = r.entity_column
         AND (f2.recorded_at, f2.id) < (r.recorded_at, r.id)
       ORDER BY f2.recorded_at DESC, f2.id DESC
       LIMIT 1
    ) prev ON true
    LEFT JOIN public.source_classes prevsc ON prevsc.code = prev.source_class
    LEFT JOIN public.projects       p   ON r.entity_table = 'projects'      AND p.id   = r.entity_id
    LEFT JOIN public.investigators  i   ON r.entity_table = 'investigators' AND i.id   = r.entity_id
    LEFT JOIN public.grants         g   ON r.entity_table = 'grants'        AND g.id   = r.entity_id
    LEFT JOIN public.publications   pub ON r.entity_table = 'publications'  AND pub.id = r.entity_id
    LEFT JOIN public.organizations  o   ON r.entity_table = 'organizations' AND o.id   = r.entity_id
    LEFT JOIN public.species        sp  ON r.entity_table = 'species'       AND sp.id  = r.entity_id
    LEFT JOIN public.software_tools stl ON r.entity_table = 'software_tools'        AND stl.id = r.entity_id
    LEFT JOIN public.device_categories    dc  ON r.entity_table = 'device_categories'    AND dc.id  = r.entity_id
    LEFT JOIN public.device_manufacturers dm  ON r.entity_table = 'device_manufacturers' AND dm.id  = r.entity_id
    LEFT JOIN public.device_models        dmo ON r.entity_table = 'device_models'        AND dmo.id = r.entity_id
    LEFT JOIN public.funding_opportunities fo ON r.entity_table = 'funding_opportunities' AND fo.id = r.entity_id
    LEFT JOIN public.announcements  an  ON r.entity_table = 'announcements'  AND an.id  = r.entity_id
    LEFT JOIN public.jobs           jb  ON r.entity_table = 'jobs'           AND jb.id  = r.entity_id
    LEFT JOIN public.resources      res ON r.entity_table = 'resources'      AND res.id = r.entity_id
    LEFT JOIN public.profiles       pr  ON r.entity_table = 'profiles'       AND pr.id  = r.entity_id
    LEFT JOIN public.system_alerts  sa  ON r.entity_table = 'system_alerts'  AND sa.id  = r.entity_id
    LEFT JOIN public.grant_investigators gi ON r.entity_table = 'grant_investigators' AND gi.id = r.entity_id
    LEFT JOIN public.investigators      gii ON gii.id = gi.investigator_id
   ORDER BY r.recorded_at DESC, r.id DESC
$fn$;

COMMENT ON FUNCTION public.provenance_activity(int, boolean, timestamptz, timestamptz) IS
  'Recent provenance events across every curated table, newest first, with the record''s name and the value each claim replaced. _since/_until bound recorded_at BEFORE the limit, so the Edit log''s date-range selector narrows the database scan instead of filtering the newest 500 rows in the browser. Hides the initial backfill stamp unless asked. The personality_scores join was removed in 20260826130000 along with the table.';

GRANT EXECUTE ON FUNCTION public.provenance_activity(int, boolean, timestamptz, timestamptz) TO authenticated;

-- ── 4. Queue ordering: drop the dead entry ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provenance_table_priority(_table text)
RETURNS int LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN _table IN ('projects', 'investigators', 'grants', 'publications', 'species',
                    'organizations', 'grant_investigators', 'investigator_organizations',
                    'project_publications', 'grant_dandisets') THEN 1
    WHEN _table IN ('software_tools', 'device_models', 'device_categories',
                    'device_manufacturers', 'device_class_crosswalk', 'resources',
                    'proposed_relations') THEN 2
    ELSE 3
  END
$fn$;

-- ── 5. Forget the claims, then the table ───────────────────────────────────────────────────────
-- Provenance about a table that no longer exists is not history, it is 2,566 rows the Edit log would
-- keep listing with no record behind them. provenance_worklist filters by scope so it drops them
-- once the table is gone, but provenance_activity() reads field_provenance DIRECTLY -- so those rows
-- would surface in the Edit log as `5b0171cb...` with no resolvable name, which is precisely the
-- failure 20260823120000 exists to prevent.
--
-- field_provenance is append-only, enforced by trg_field_provenance_append_only (BEFORE UPDATE OR
-- DELETE, no exemption). That rule protects against a CLAIM being quietly rewritten -- and there is
-- no "record a new row instead" that can express "the entity this describes no longer exists".
--
-- So the trigger is disabled for this one statement, on the 20260811120000 precedent, and the rows
-- are not destroyed: section 0 already copied every one of them to
-- removed_personality.field_provenance. Nothing is rewritten and nothing is lost; the claims simply
-- stop living in a store whose subject is gone.
DO $do$
DECLARE _n int; _guarded boolean;
BEGIN
  _guarded := EXISTS (SELECT 1 FROM pg_trigger
                       WHERE tgrelid = 'public.field_provenance'::regclass
                         AND tgname = 'trg_field_provenance_append_only' AND NOT tgisinternal);
  IF _guarded THEN
    ALTER TABLE public.field_provenance DISABLE TRIGGER trg_field_provenance_append_only;
  END IF;

  DELETE FROM public.field_provenance WHERE entity_table = 'personality_scores';
  GET DIAGNOSTICS _n = ROW_COUNT;
  RAISE NOTICE 'field_provenance: % claim(s) about personality_scores removed (copied to removed_personality.field_provenance in section 0)', _n;

  IF _guarded THEN
    ALTER TABLE public.field_provenance ENABLE TRIGGER trg_field_provenance_append_only;
  END IF;
END
$do$;

-- No CASCADE. If this errors, section 1 missed a dependent -- rewrite that object and re-run rather
-- than reaching for CASCADE.
DROP TABLE public.personality_scores;

-- ── Verify ─────────────────────────────────────────────────────────────────────────────────────
-- 1) Gone, with nothing left behind.
SELECT to_regclass('public.personality_scores') IS NULL AS table_dropped,           -- expect true
       (SELECT count(*) FROM public.field_provenance
         WHERE entity_table = 'personality_scores')     AS claims_left;             -- expect 0

-- 2) The two rewritten objects still work. Neither should error, and the graph should still be
--    named -- a blank record_label would mean a join was lost with the personality one.
SELECT count(*) AS worklist_rows,
       count(*) FILTER (WHERE record_label LIKE '%...') AS unnamed_rows
  FROM public.provenance_worklist;
SELECT count(*) AS activity_rows FROM public.provenance_activity(200);
SELECT count(*) AS windowed_rows FROM public.provenance_activity(200, false, now() - interval '1 month', NULL);

-- 3) The backup is readable and holds what was removed.
SELECT (SELECT count(*) FROM removed_personality.personality_scores) AS scores_kept,
       (SELECT count(*) FROM removed_personality.field_provenance)   AS claims_kept;

-- 4) Provenance coverage no longer counts a table that is gone.
SELECT * FROM public.provenance_coverage WHERE table_name = 'personality_scores';   -- expect no rows

-- 5) The append-only guard is back on. It was disabled for exactly one DELETE; left off, the store
--    silently stops being append-only and nothing else would report it.
SELECT tgname, tgenabled   -- expect 'O'
  FROM pg_trigger
 WHERE tgrelid = 'public.field_provenance'::regclass
   AND tgname = 'trg_field_provenance_append_only';
