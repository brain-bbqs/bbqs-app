-- A change log that actually covers the graph. The Edit log tab was reading the wrong table.
--
-- WHAT WAS WRONG. /data-provenance's "Edit log" is headed "Track all metadata changes across the
-- consortium" and reads `edit_history`, which is keyed on grant_number + field_name. Only the
-- project-questionnaire save path ever writes there, and its newest row is 2026-03-18. So:
--
--   * a member edits their own research_areas -> field_provenance records it correctly (verified:
--     two direct_write claims, curator_fill, 2026-08-23 01:31) and the Edit log cannot show it,
--     because an investigator edit has no grant_number;
--   * the Overview's curator queue only lists UNVERIFIED cells, and curator_fill is verified, so a
--     curator's own edit correctly leaves the queue rather than appearing anywhere;
--   * net effect: the edit happened, was graded, was attributed -- and every view on the page was
--     structurally incapable of showing it. Reported as "I changed something and it doesn't show".
--
-- field_provenance IS the consortium-wide change log. It is append-only, spans every curated table,
-- and carries agent, activity, grade and the value. This exposes it in the shape the page needs.
--
-- WHY A FUNCTION AND NOT A VIEW. The previous value of a cell is the previous claim on that cell,
-- which means a window or a lateral over 92,475 rows. As an unbounded view the planner has no limit
-- to push down and the lateral runs for the whole table -- the same mistake that cost 1.4s in
-- 20260822140000. A function takes the limit as an argument, so the expensive part runs for the
-- rows actually displayed and nothing else.
--
-- BACKFILL IS NOT ACTIVITY. 91,178 of the 92,475 claims are the initial `backfill` stamp. Included
-- by default they would bury the ~170 real events completely, so the caller opts in. This is the
-- same judgement as excluding bookkeeping columns: a log that shows everything shows nothing.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260823120000');

-- ── 1. Index for "newest first", which is how a log is always read ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_field_prov_recorded_at
  ON public.field_provenance (recorded_at DESC, id DESC);

-- ── 2. The log ──────────────────────────────────────────────────────────────────────────────
/** Recent provenance events across every curated table, newest first.
 *
 *  _include_backfill = false (the default) hides the one-off backfill stamp, which is 98.6% of the
 *  store and none of it a change anyone made.
 *
 *  SECURITY: SECURITY INVOKER, so the caller's RLS on field_provenance applies unchanged -- admins
 *  and curators only, exactly as when reading the table directly. */
CREATE OR REPLACE FUNCTION public.provenance_activity(
  _limit int DEFAULT 500,
  _include_backfill boolean DEFAULT false
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

COMMENT ON FUNCTION public.provenance_activity(int, boolean) IS
  'Recent provenance events across every curated table, newest first, with the record''s name and the value each claim replaced. This is the consortium-wide change log the /data-provenance Edit log tab claimed to be: it previously read edit_history, which is grant-keyed and only written by the project questionnaire, so an investigator or species edit could never appear. Takes a limit because the previous-value lookup must be bounded -- as an unbounded view it would run over all 92k claims. Hides the initial backfill stamp unless asked, since that is 98.6% of the rows and none of it a change anyone made.';

GRANT EXECUTE ON FUNCTION public.provenance_activity(int, boolean) TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) The reported edit appears, with its grade, its author, and what it replaced.
SELECT recorded_at, entity_table, record_label, entity_column,
       source_grade, source_label, activity, agent_label,
       left(value_text, 40) AS new_value, left(prev_value, 40) AS old_value
  FROM public.provenance_activity(20)
 ORDER BY recorded_at DESC;

-- 2) It spans more than grants -- the whole point. Expect investigators, projects, publications...
SELECT entity_table, count(*) AS events
  FROM public.provenance_activity(2000)
 GROUP BY entity_table ORDER BY events DESC;

-- 3) Backfill stays out by default and comes back on request.
SELECT (SELECT count(*) FROM public.provenance_activity(2000, false)) AS without_backfill,
       (SELECT count(*) FROM public.provenance_activity(2000, true))  AS with_backfill;

-- 4) Cost. The lateral must run for the returned rows only.
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.provenance_activity(500);
