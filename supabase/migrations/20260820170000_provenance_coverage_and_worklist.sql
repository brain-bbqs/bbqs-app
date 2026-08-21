-- Make provenance answerable for the WHOLE graph, and give curators a queue rather than a table.
-- Constitution Principles X and XI.
--
-- WHY. The guard records a claim when a row is WRITTEN, so a row nobody has touched since the guard
-- went in has no claim at all. Today that means 1,299 claims for projects and zero for everything
-- else: 243 investigators, 262 resources, 104 roster rows, 45 publications, 35 organizations, 31
-- grants, 14 species. The UI shows nothing for them, which reads as "fine" when it means "unknown" —
-- the exact inversion Principle XI exists to prevent. Absence has to be visible.
--
-- SO: backfill every guarded table with an honest 'unknown' claim per cell, the same move P1 made for
-- projects. Coverage will look far worse afterwards. That is the point; it was always this bad, and
-- only projects was telling the truth about it.
--
-- AND: a curator needs a worklist, not a browser. Scrolling ten thousand rows tells nobody anything.
-- provenance_worklist is unverified cells, worst grade first, with the record's human-readable name
-- attached, so it can be worked down and seen to empty. provenance_coverage is the number that says
-- whether it is emptying.
--
-- The encoding matches the trigger and the earlier backfills exactly — arrays comma-joined, jsonb
-- addressed per key — because value_text is only useful if one shape means one thing.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260820170000');

-- ── 1. Backfill: stamp what exists as unsourced, table by table ──────────────────────────────
CREATE OR REPLACE FUNCTION public.provenance_backfill_unknown(_table text)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.provenance_guardable_tables WHERE table_name = _table) THEN
    RETURN 0;
  END IF;

  -- One statement per table, driven by to_jsonb of the row so the value encoding is identical to
  -- the trigger's. Anything else and value_text stops being comparable across sources.
  EXECUTE format($q$
    WITH src AS (
      SELECT (to_jsonb(t) ->> 'id')::uuid AS eid, to_jsonb(t) AS j FROM public.%I t
    ), flat AS (
      SELECT s.eid, kv.key AS col,
             CASE WHEN jsonb_typeof(kv.value) = 'array'
                  THEN (SELECT string_agg(e, ', ') FROM jsonb_array_elements_text(kv.value) AS e)
                  ELSE s.j ->> kv.key END AS val
        FROM src s, jsonb_each(s.j) kv
       WHERE jsonb_typeof(kv.value) <> 'object'
      UNION ALL
      -- A jsonb column is many values; each key is its own cell, as everywhere else.
      SELECT s.eid, kv.key || '.' || k2.key,
             CASE WHEN jsonb_typeof(k2.value) = 'string'
                  THEN k2.value #>> '{}' ELSE k2.value::text END
        FROM src s, jsonb_each(s.j) kv, jsonb_each(kv.value) k2
       WHERE jsonb_typeof(kv.value) = 'object' AND k2.key <> 'field_provenance'
    )
    INSERT INTO public.field_provenance (
      entity_table, entity_id, entity_column, source_class, activity,
      agent_label, value_text, recorded_by)
    SELECT %L, f.eid, f.col, 'unknown', 'backfill',
           'predates-provenance', left(f.val, 500), 'migration:20260820170000'
      FROM flat f
     WHERE f.eid IS NOT NULL
       AND NOT (split_part(f.col, '.', 1) = ANY (public.provenance_excluded_columns()))
       AND btrim(coalesce(f.val, '')) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM public.field_provenance fp
          WHERE fp.entity_table = %L AND fp.entity_id = f.eid AND fp.entity_column = f.col)
  $q$, _table, _table, _table);

  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.provenance_backfill_all()
RETURNS TABLE(table_name text, claims_added int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _t text;
BEGIN
  FOR _t IN SELECT g.table_name FROM public.provenance_guardable_tables g ORDER BY g.table_name LOOP
    RETURN QUERY SELECT _t, public.provenance_backfill_unknown(_t);
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.provenance_backfill_all() IS
  'Stamps an honest unknown claim on every cell of every guarded table that has no claim yet. Idempotent, so it is safe to re-run after adding a table or a column.';

GRANT EXECUTE ON FUNCTION public.provenance_backfill_unknown(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.provenance_backfill_all() TO service_role;

SELECT * FROM public.provenance_backfill_all();

-- ── 2. Coverage: the number that says whether this is getting better ────────────────────────
CREATE OR REPLACE VIEW public.provenance_coverage
WITH (security_invoker = true)
AS
SELECT g.table_name,
       count(fpc.entity_column)                                    AS cells,
       count(fpc.entity_column) FILTER (WHERE fpc.is_verified)     AS verified,
       count(fpc.entity_column) FILTER (WHERE NOT fpc.is_verified) AS unverified,
       round(100.0 * count(fpc.entity_column) FILTER (WHERE fpc.is_verified)
             / nullif(count(fpc.entity_column), 0), 1)             AS pct_verified,
       count(DISTINCT fpc.entity_id)                               AS rows_with_claims
  FROM public.provenance_guardable_tables g
  LEFT JOIN public.field_provenance_current fpc ON fpc.entity_table = g.table_name
 GROUP BY g.table_name;

COMMENT ON VIEW public.provenance_coverage IS
  'Per table: how many cells carry a provenance claim and how many of those are human- or registry-backed. A table with 0 cells has never been written since the guard went in and has not been backfilled.';

-- ── 3. The worklist ──────────────────────────────────────────────────────────────────────────
/** A human-readable name for a record, so the queue reads as work rather than as uuids. Explicit
 *  per table rather than dynamic: a lateral lookup per row would make the grid crawl, and the six
 *  tables below are where the curation actually happens. */
CREATE OR REPLACE VIEW public.provenance_worklist
WITH (security_invoker = true)
AS
SELECT fpc.entity_table,
       fpc.entity_id,
       fpc.entity_column,
       fpc.source_class,
       fpc.source_grade,
       fpc.source_label,
       fpc.value_text,
       fpc.agent_label,
       fpc.recorded_at,
       coalesce(p.grant_number, i.name, g.grant_number, pub.title, o.name, s.common_name,
                fpc.entity_id::text) AS record_label
  FROM public.field_provenance_current fpc
  LEFT JOIN public.projects       p   ON fpc.entity_table = 'projects'      AND p.id   = fpc.entity_id
  LEFT JOIN public.investigators  i   ON fpc.entity_table = 'investigators' AND i.id   = fpc.entity_id
  LEFT JOIN public.grants         g   ON fpc.entity_table = 'grants'        AND g.id   = fpc.entity_id
  LEFT JOIN public.publications   pub ON fpc.entity_table = 'publications'  AND pub.id = fpc.entity_id
  LEFT JOIN public.organizations  o   ON fpc.entity_table = 'organizations' AND o.id   = fpc.entity_id
  LEFT JOIN public.species        s   ON fpc.entity_table = 'species'       AND s.id   = fpc.entity_id
 WHERE NOT fpc.is_verified;

COMMENT ON VIEW public.provenance_worklist IS
  'Every cell no human or registry stands behind, with the record it belongs to. Order by source_grade DESC to work the worst first. Empties as cells are verified or re-sourced -- which is the point of it being a queue and not a report.';

GRANT SELECT ON public.provenance_coverage, public.provenance_worklist TO authenticated;

-- ── 4. A curator saying "I checked this" ─────────────────────────────────────────────────────
/** Verifying is not editing. The value does not change; what changes is that a named person now
 *  stands behind it, which is a new claim at their own grade. */
CREATE OR REPLACE FUNCTION public.provenance_mark_verified(
  _table text, _id uuid, _column text, _note text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _val text;
  _who text;
BEGIN
  IF auth.uid() IS NULL
     OR NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can verify a field';
  END IF;

  SELECT fpc.value_text INTO _val
    FROM public.field_provenance_current fpc
   WHERE fpc.entity_table = _table AND fpc.entity_id = _id AND fpc.entity_column = _column;

  IF _val IS NULL THEN
    RAISE EXCEPTION 'No provenance claim for %.% on % -- nothing to verify', _table, _column, _id;
  END IF;

  SELECT coalesce(u.email, auth.uid()::text) INTO _who FROM auth.users u WHERE u.id = auth.uid();

  RETURN public.record_field_provenance(
    _table, _id, _column, 'curator_fill', 'curator_verified',
    _who, NULL, _val,
    coalesce(nullif(btrim(_note), ''), 'Checked and confirmed by a curator; value unchanged.'));
END;
$fn$;

COMMENT ON FUNCTION public.provenance_mark_verified(text, uuid, text, text) IS
  'Records that a named curator has checked a value and stands behind it, without changing the value. Admin/curator only. The old claim stays in the append-only history, so "this was unsourced until someone checked it" remains readable.';

GRANT EXECUTE ON FUNCTION public.provenance_mark_verified(text, uuid, text, text) TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Coverage per table. Every guarded table should now have cells; pct_verified will be low
--    everywhere except projects, which is the honest picture rather than a flattering one.
SELECT * FROM public.provenance_coverage ORDER BY unverified DESC NULLS LAST;

-- 2) The whole graph in one line. Expect the percentage to DROP sharply from 90% -- that number was
--    projects-only, and projects is the one thing that had already been worked on.
SELECT sum(cells) AS cells, sum(verified) AS verified,
       round(100.0 * sum(verified) / nullif(sum(cells), 0), 1) AS pct_verified
  FROM public.provenance_coverage;

-- 3) The queue, worst first. This is what a curator actually works.
SELECT entity_table, record_label, entity_column, source_label, left(value_text, 40) AS value
  FROM public.provenance_worklist
 ORDER BY source_grade DESC, entity_table, record_label
 LIMIT 25;

-- 4) Nothing was left behind: a guarded table with cells = 0 means the backfill skipped it.
SELECT table_name FROM public.provenance_coverage WHERE cells = 0 ORDER BY table_name;
