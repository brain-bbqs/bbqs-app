-- The Edit log needs a window, not just a ceiling.
--
-- WHAT WAS WRONG. provenance_activity() takes only `_limit`, so the Edit log tab is "the newest 500
-- events, whenever they happened". Two consequences, both now visible:
--
--   * the grid gets long enough to be unreadable, and there is no way to narrow it to "what changed
--     this month" -- the question people actually arrive with;
--   * a client-side date filter cannot fix that, because the 500-row ceiling is applied FIRST. Ask
--     for "last week" and you filter within the newest 500; ask for an old month and you get
--     nothing at all, because those rows never left the database. The window has to be pushed down.
--
-- So: two optional bounds, applied inside the CTE, before the LIMIT. `_since`/`_until` NULL keeps
-- the previous behaviour exactly, which is what the deployed JS passes today.
--
-- WHY DROP AND RECREATE. Adding parameters to an existing function does not replace it -- it
-- creates an OVERLOAD, and provenance_activity(500, false) then fails as ambiguous (42725). The
-- drop is safe for the currently-deployed JS: PostgREST resolves RPC by argument NAME, and the new
-- signature still accepts {_limit, _include_backfill} alone via the defaults.
--
-- The (recorded_at DESC, id DESC) index from 20260823120000 already serves the range scan; no new
-- index is needed.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260824120000');

DROP FUNCTION IF EXISTS public.provenance_activity(int, boolean);

/** Recent provenance events across every curated table, newest first.
 *
 *  _include_backfill = false (the default) hides the one-off backfill stamp, which is 98.6% of the
 *  store and none of it a change anyone made.
 *
 *  _since / _until bound recorded_at. Both NULL = unbounded, the pre-existing behaviour. They are
 *  applied BEFORE the limit, so "last month" means the newest 500 events in that month rather than
 *  whichever of the newest 500 events overall happen to fall in it.
 *
 *  SECURITY: SECURITY INVOKER, so the caller's RLS on field_provenance applies unchanged -- admins
 *  and curators only, exactly as when reading the table directly. */
CREATE OR REPLACE FUNCTION public.provenance_activity(
  _limit int DEFAULT 500,
  _include_backfill boolean DEFAULT false,
  _since timestamptz DEFAULT NULL,
  _until timestamptz DEFAULT NULL
)
RETURNS TABLE (
  -- bigint, not uuid: field_provenance.id is a bigserial. Declaring uuid here fails at RUNTIME with
  -- "structure of query does not match function result type", not at creation time.
  id bigint,
  recorded_at timestamptz,
  entity_table text,
  entity_id uuid,
  entity_column text,
  record_label text,
  source_class text,
  source_grade int,
  source_label text,
  is_verified boolean,
  activity text,
  agent_label text,
  agent_kind text,
  value_text text,
  prev_value text,
  prev_source_label text,
  source_ref text,
  recorded_by text
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
  SELECT r.id,
         r.recorded_at,
         r.entity_table,
         r.entity_id,
         r.entity_column,
         -- A uuid tells a reviewer nothing; the record's own name does. Same join set as
         -- provenance_worklist, so the two pages name the same row the same way.
         coalesce(
           p.grant_number, i.name, g.grant_number, pub.title, o.name, sp.common_name,
           stl.name, dc.label, dm.name, dmo.model_name,
           fo.title, an.title, jb.title, res.name, pr.full_name, sa.message,
           psi.name, gii.name,
           left(r.entity_id::text, 8) || '...'
         )::text AS record_label,
         r.source_class,
         sc.grade,
         sc.label,
         sc.is_verified,
         r.activity,
         r.agent_label,
         sc.agent_kind::text,
         r.value_text,
         -- The value this claim replaced: the newest EARLIER claim on the same cell. Bounded by the
         -- CTE above, so this is one index lookup per displayed row rather than a whole-table window.
         -- Deliberately NOT bounded by _since: the claim a row replaced may predate the window, and
         -- "Old Value" blanking out at the window edge would misreport the history.
         prev.value_text,
         prevsc.label,
         r.source_ref,
         r.recorded_by
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
    LEFT JOIN public.personality_scores  ps ON r.entity_table = 'personality_scores' AND ps.id = r.entity_id
    LEFT JOIN public.investigators      psi ON psi.id = ps.investigator_id
    LEFT JOIN public.grant_investigators gi ON r.entity_table = 'grant_investigators' AND gi.id = r.entity_id
    LEFT JOIN public.investigators      gii ON gii.id = gi.investigator_id
   ORDER BY r.recorded_at DESC, r.id DESC
$fn$;

COMMENT ON FUNCTION public.provenance_activity(int, boolean, timestamptz, timestamptz) IS
  'Recent provenance events across every curated table, newest first, with the record''s name and the value each claim replaced. This is the consortium-wide change log the /data-provenance Edit log tab claimed to be: it previously read edit_history, which is grant-keyed and only written by the project questionnaire, so an investigator or species edit could never appear. Takes a limit because the previous-value lookup must be bounded -- as an unbounded view it would run over all 92k claims. _since/_until bound recorded_at BEFORE the limit, so the Edit log date-range selector narrows the database scan instead of filtering the newest 500 rows in the browser. Hides the initial backfill stamp unless asked, since that is 98.6% of the rows and none of it a change anyone made.';

GRANT EXECUTE ON FUNCTION public.provenance_activity(int, boolean, timestamptz, timestamptz) TO authenticated;

-- Verify ---------------------------------------------------------------------------------------
-- 1) Unbounded still behaves exactly as before, and the old 2-arg call site still resolves.
SELECT count(*) AS unbounded FROM public.provenance_activity(2000);
SELECT count(*) AS old_call_site
  FROM public.provenance_activity(_limit => 2000, _include_backfill => false);

-- 2) A one-month window returns a subset, and every row is inside it.
WITH w AS (
  SELECT * FROM public.provenance_activity(2000, false, now() - interval '1 month', NULL)
)
SELECT count(*) AS in_window,
       min(recorded_at) AS oldest,
       bool_and(recorded_at >= now() - interval '1 month') AS all_inside
  FROM w;

-- 3) The window is pushed DOWN, not applied after the limit: asking for an OLD month with a small
--    limit must still return that month's rows, which a client-side filter could never do.
SELECT count(*) AS old_month_rows
  FROM public.provenance_activity(50, true, now() - interval '6 months', now() - interval '5 months');

-- 4) Cost. The range scan must use idx_field_prov_recorded_at, not a seq scan.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.provenance_activity(500, false, now() - interval '1 month', NULL);
