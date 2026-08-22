-- Filter BEFORE the DISTINCT ON. 88% of every provenance query was spent on rows it then discarded.
--
-- WHAT THE PLAN SHOWED. EXPLAIN (ANALYZE) on provenance_coverage, 1616ms:
--
--   Index Scan on field_provenance   rows=92475   actual time=2.982..1448.989
--   Unique                           rows=91304
--   Hash Right Join                  rows=11117     <- only now does scope apply
--   pg_attribute index scan          loops=11117, buffers=33349
--
-- Two things, both structural:
--
-- 1. THE SCAN IS 88% WASTE. field_provenance holds 92,475 claims; 11,111 are the standing in-scope
--    cells. The other 81,364 are superseded claims and the orphans from tables that later left scope
--    (append-only, so they cannot be deleted -- correctly). Every query read all of them, ran
--    DISTINCT ON over all 91,304 distinct cells, and only THEN joined provenance_guardable_tables to
--    throw 88% away. Filtering entity_table first turns a 92k sort into an 11k one.
--
-- 2. THE SCOPE CHECK RAN PER ROW. provenance_guardable_tables asks pg_attribute whether a table has
--    a uuid `id`. As a join it was re-evaluated for each surviving row: 11,117 loops and 33,349
--    buffer hits to answer the same 29-row question. A MATERIALIZED CTE answers it once.
--
-- My previous attempt at this fixed claim_count (a correlated subquery, genuinely wasteful) and the
-- RLS predicate (evaluated per row, genuinely wasteful) -- and neither was the dominant cost. The
-- plan says so plainly: 1449 of 1616ms is the index scan itself. I should have asked for a plan
-- before optimising rather than after.
--
-- Column names and order are preserved in both views, so CREATE OR REPLACE accepts them.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260822140000');

-- ── 1. Coverage: prune, then aggregate ──────────────────────────────────────────────────────
-- Deliberately NOT built on field_provenance_current: that view cannot pre-filter, because it has
-- no idea what is in scope. Reading field_provenance directly is what lets the WHERE come first.
CREATE OR REPLACE VIEW public.provenance_coverage
WITH (security_invoker = true)
AS
WITH scope AS MATERIALIZED (
  -- MATERIALIZED matters: without it the planner inlines this and re-asks pg_attribute per row.
  SELECT table_name FROM public.provenance_guardable_tables
), standing AS (
  SELECT DISTINCT ON (fp.entity_table, fp.entity_id, fp.entity_column)
         fp.entity_table, fp.entity_id, fp.source_class
    FROM public.field_provenance fp
   WHERE fp.entity_table IN (SELECT table_name FROM scope)
   ORDER BY fp.entity_table, fp.entity_id, fp.entity_column, fp.recorded_at DESC, fp.id DESC
)
SELECT s.table_name,
       count(st.entity_table)                                            AS cells,
       count(st.entity_table) FILTER (WHERE sc.is_verified)              AS verified,
       count(st.entity_table) FILTER (WHERE NOT sc.is_verified)          AS unverified,
       round(100.0 * count(st.entity_table) FILTER (WHERE sc.is_verified)
             / nullif(count(st.entity_table), 0), 1)                     AS pct_verified,
       count(DISTINCT st.entity_id)                                      AS rows_with_claims
  FROM scope s
  LEFT JOIN standing st ON st.entity_table = s.table_name
  LEFT JOIN public.source_classes sc ON sc.code = st.source_class
 GROUP BY s.table_name;

COMMENT ON VIEW public.provenance_coverage IS
  'Per table: how many cells carry a provenance claim and how many are human- or registry-backed. Reads field_provenance directly and filters entity_table BEFORE the DISTINCT ON -- 88% of the table is superseded or out-of-scope claims, and sorting them first cost 1.4 seconds.';

GRANT SELECT ON public.provenance_coverage TO authenticated;

-- ── 2. Worklist: same pruning ───────────────────────────────────────────────────────────────
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
         psi.name, gii.name,
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
  LEFT JOIN public.personality_scores  ps ON st.entity_table = 'personality_scores' AND ps.id = st.entity_id
  LEFT JOIN public.investigators      psi ON psi.id = ps.investigator_id
  LEFT JOIN public.grant_investigators gi ON st.entity_table = 'grant_investigators' AND gi.id = st.entity_id
  LEFT JOIN public.investigators      gii ON gii.id = gi.investigator_id;

COMMENT ON VIEW public.provenance_worklist IS
  'In-scope cells nobody stands behind, with a readable name for the record. Filters entity_table before the DISTINCT ON and drops verified rows in the join, so the label lookups only run for rows that will be shown. Order by priority, then source_grade DESC.';

GRANT SELECT ON public.provenance_worklist TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Same shape as before. coverage 6 columns, worklist 11, in the same order.
SELECT table_name, ordinal_position, column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name IN ('provenance_coverage', 'provenance_worklist')
 ORDER BY table_name, ordinal_position;

-- 2) Same ANSWERS as before: 11,111 cells and 1,174 verified.
SELECT sum(cells) AS cells, sum(verified) AS verified,
       round(100.0 * sum(verified) / nullif(sum(cells), 0), 1) AS pct
  FROM public.provenance_coverage;

-- 3) The plan that was 1616ms. Expect the row count entering the sort to be ~11k rather than 92k.
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.provenance_coverage;

-- 4) And the queue as the page asks for it.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.provenance_worklist
 ORDER BY priority, source_grade DESC, entity_table
 LIMIT 400;
