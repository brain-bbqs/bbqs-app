-- Make the provenance views usable for the people they are for. Fixes 57014 on /data-provenance.
--
-- THE ERROR. The Field grades tab reported, verbatim:
--     57014: canceling statement due to statement timeout
--
-- TWO CAUSES, and the first one is why I did not catch it. I verified these views with the
-- service-role key, which BYPASSES ROW LEVEL SECURITY, so every timing I took missed the cost that
-- actually matters. Service role: provenance_coverage in 1.58s. A curator: timeout.
--
-- 1. THE RLS PREDICATE RAN PER ROW. The policy was
--      USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator'))
--    has_role is STABLE and SECURITY DEFINER, which is not enough: inside a USING clause Postgres
--    evaluates it once PER ROW, and field_provenance has 92,475 of them. Wrapping the whole
--    predicate in a scalar subquery makes it an InitPlan, evaluated once for the statement. Same
--    result, one call instead of ninety-two thousand.
--
-- 2. claim_count WAS A CORRELATED SUBQUERY. field_provenance_current computed
--      (SELECT count(*) FROM field_provenance p2 WHERE p2.entity_table = ... AND ...)
--    for every row it returned — an index lookup per row, on top of the DISTINCT ON sort. A window
--    function over the same partition the DISTINCT ON already sorts by gets it for free: the sort
--    happens once and the count comes out of it. Window functions are evaluated before DISTINCT ON,
--    so the count still covers every claim for the cell, not just the surviving one.
--
-- The column keeps its name and its position (18 of 21), so CREATE OR REPLACE VIEW accepts this.
-- Inserting or reordering would fail with 42P16 — see tests/guards/view-columns-append-only.test.mjs,
-- which exists because that has already happened three times.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260822130000');

-- ── 1. One RLS check per statement, not per row ──────────────────────────────────────────────
DROP POLICY IF EXISTS "staff read field provenance" ON public.field_provenance;
CREATE POLICY "staff read field provenance" ON public.field_provenance
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator')));

COMMENT ON POLICY "staff read field provenance" ON public.field_provenance IS
  'Admins and curators only. The predicate is wrapped in a scalar subquery deliberately: as a bare expression Postgres evaluates it once per row, which across 92k rows timed the page out with 57014.';

-- Same shape for the ladder, which every provenance view joins.
DROP POLICY IF EXISTS "anyone signed in reads the ladder" ON public.source_classes;
CREATE POLICY "anyone signed in reads the ladder" ON public.source_classes
  FOR SELECT TO authenticated USING (true);

-- ── 2. claim_count as a window function ─────────────────────────────────────────────────────
-- Column list reproduced exactly, in order, with only the claim_count EXPRESSION changed.
CREATE OR REPLACE VIEW public.field_provenance_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (fp.entity_table, fp.entity_id, fp.entity_column)
       fp.entity_table,
       fp.entity_id,
       fp.entity_column,
       fp.source_class,
       sc.grade        AS source_grade,
       sc.label        AS source_label,
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
       -- Was a correlated subquery per returned row. The DISTINCT ON already sorts by exactly this
       -- partition, so the window function rides along on that sort for nothing.
       count(*) OVER (PARTITION BY fp.entity_table, fp.entity_id, fp.entity_column) AS claim_count,
       fp.authored_at,
       fp.authored_at_precision
  FROM public.field_provenance fp
  JOIN public.source_classes sc ON sc.code = fp.source_class
 ORDER BY fp.entity_table, fp.entity_id, fp.entity_column, fp.recorded_at DESC, fp.id DESC;

COMMENT ON VIEW public.field_provenance_current IS
  'The standing provenance claim for each cell: newest row per (table, id, column), with its grade and is_verified. claim_count is a window function over the same partition the DISTINCT ON sorts by -- as a correlated subquery it cost an index lookup per row and helped time the page out.';

GRANT SELECT ON public.field_provenance_current TO authenticated;

-- ── 3. Index for the shape these views actually scan ────────────────────────────────────────
-- idx_field_prov_cell already matches the DISTINCT ON ordering. This one serves the other half:
-- the ~79,600 claims belonging to tables that are now out of scope are still in the table, and
-- every view filters them out by joining provenance_guardable_tables. Letting the planner find rows
-- by entity_table first keeps that filter cheap.
CREATE INDEX IF NOT EXISTS idx_field_prov_table_verified
  ON public.field_provenance (entity_table, entity_column);

ANALYZE public.field_provenance;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) The column order is unchanged, so nothing downstream broke. Expect claim_count at 19 of 21.
SELECT ordinal_position, column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'field_provenance_current'
 ORDER BY ordinal_position;

-- 2) claim_count still counts every claim for a cell, not just the surviving one. The Marr fields
--    were written twice (backfill, then the AI-authorship correction), so expect 2 or more.
SELECT entity_column, claim_count
  FROM public.field_provenance_current
 WHERE entity_table = 'projects' AND entity_column = 'metadata.marr_l1_ethological_goal'
 LIMIT 3;

-- 3) The policy is the subquery form. Expect the USING clause to contain a SELECT.
SELECT polname, pg_get_expr(polqual, polrelid) AS using_clause
  FROM pg_policy WHERE polrelid = 'public.field_provenance'::regclass;

-- 4) Timing, as a CURATOR rather than as service role — which is the mistake that let this ship.
--    Run this signed in as an admin in the SQL editor's "Run as role" if available, or just load
--    /data-provenance and watch it come back.
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.provenance_coverage;
