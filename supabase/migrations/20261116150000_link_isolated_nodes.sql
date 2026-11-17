-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261116150000_link_isolated_nodes.sql
-- Link, or remove, the knowledge-graph nodes that have no edge at all.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHAT AND WHY
--   The 2026-11-04 export (kg/export, 808 nodes) has 189 isolated nodes. Each was diagnosed, and the
--   diagnosis re-checked. They are rows that should not exist (the EMBER test uploads listed in #506,
--   duplicates that earlier merges left behind, a test account); rows whose link the repo records but
--   no column the exporter reads holds (a person's institution, an announcement's or a call's
--   organization, a dataset's project); links PR #512 already made live that become edges only when
--   #512's exporter half merges; and nodes nothing ties to anything yet.
--   This script makes every fix a database change can make AND the records support (Principle III:
--   decide from the system of record; no evidence, no write). It builds on #517 (the 11-03 hand edits:
--   organizations on announcements and jobs, curator links for 000207/000598) and on #512's
--   migrations (the funder organizations). Every write is audited as 'migration:link_isolated_nodes'.
--
-- HOW TO APPLY: Supabase SQL editor, project vpexxhfpvghlejljwpvt, as its default role (postgres).
-- Paste the WHOLE file, then Run.
--   1. As shipped it is a DRY RUN: every block runs, the report is shown, then everything is rolled
--      back. The editor may warn about DELETE/DROP statements; in a dry run nothing is kept.
--   2. Read the report (the script's last statement, the only result the editor shows): the RESULT
--      row, one row per block (rows = rows written), then each decision. 'skipped' rows name what a
--      curator should look at. If any row says 'error', a real run would change nothing.
--   3. Apply: in the DRY-RUN SWITCH line just below BEGIN, change 'on' to 'off' (the only edit), and
--      Run the whole file again. It is one transaction: any unexpected error rolls ALL of it back, and
--      the editor then shows the list of errors instead of the report.
--   4. A second run changes nothing and reports 0 rows. A run takes seconds; while it runs it locks
--      field_provenance (people-03), and dandisets only if 20261105120000 was never applied.
--
-- PRECONDITIONS
--   * PR #512's migrations are live (20261103130000, 20261103140000, 20261106120000): the funder
--     organizations they created are what people-05 and notices-04 link to.
--   * Deploy the new ember-dandiset-sync (16be24c) BEFORE this script, or run the script again after
--     its next nightly run (04:17 UTC; do not run during it): the old sync re-creates a node for every
--     dataset hidden here. The D00 report row says which sync answered last.
--   * 20261105120000_dandiset_hidden need not be applied: D01 adds its columns, CHECK and
--     set_dandiset_hidden() where they are missing and changes nothing where they exist.
--
-- VERIFY
--   * RESULT says APPLIED, no row says error, and a second run reports 0 rows.
--   * SELECT table_name, operation, count(*) FROM public.data_audit_log
--      WHERE actor_label = 'migration:link_isolated_nodes' GROUP BY 1, 2 ORDER BY 1, 2;
--   * Re-export the graph (kg/export.py) and run kg/quality.py: isolated nodes 189 -> 70-75.
--
-- UNDO
--   data_audit_log keeps each changed row under actor_label 'migration:link_isolated_nodes': old_data
--   for every UPDATE and DELETE, new_data for every INSERT. Re-insert a deleted row from old_data (same
--   id, so its node IRI returns), restore updated columns, delete inserted rows by id. To unhide a
--   dataset, re-insert its resources row from old_data and set dandisets.hidden = false and
--   resource_id; set_dandiset_hidden(ARRAY['000…'], false) also works but gives it a new node id.
--   Not restorable from data_audit_log:
--   * knowledge_embeddings rows deleted with their spine rows (chat search index; embed-knowledge
--     rebuilds them) and the species_aliases rows D09 adds (delete them by alias): no audit trigger;
--   * field_provenance: people-03 moves the duplicate's claims onto the keeper (not audited);
--   * DDL: public.resource_links with its function, triggers and policy (tools-04), and, if D01 had
--     to apply 20261105120000, dandisets.hidden*, its CHECK and set_dandiset_hidden(). Drop by hand.
--
-- THE BLOCKS, in run order. n = isolated nodes of the 11-04 export the block fixes when its guards
-- pass (each node counted once, at the first block that links or deletes it). Every block re-reads
-- the live rows and skips, with a report row, whatever is no longer as the export showed it. Deletes
-- and merges run first, so names are free before anything is inserted.
--   n   block        what it does
--  14   people-01    delete 14 orphan person spine rows (no person row; the real person is the twin)
--   1   people-02    delete the 'TestUser Tier2' test record
--   1   people-03    merge 'Niegil Francis Muttath Joseph' into 'Niegil Francis' (one NYU identity)
--   1   tools-01     fold the duplicate Lightning Pose row 444f664a into 3ba48c59
--   1   notices-03   merge the superseded forecast RFA-NS-26-011 into RFA-NS-27-002
--   0   datasets-D01 apply 20261105120000 (dandisets.hidden*) where it is missing
--  28   datasets-D02 hide the 28 IDP/ARC integration-test uploads (#506)
--   4   datasets-D03 hide the test uploads 000001, 000003, 000431, 000467 (#506)
--   1   datasets-D04 hide 000468 'Single Click Science' (synthetic mock data, #444 Exclude)
--   1   datasets-D05 000472 'Pozu: Missing subjects': hide it if it has 0 files, else link to EMBER
--   1   datasets-D09 merge species 'Acoel Flatworm' into Hofstenia miamia
--   0   people-06    create University College London and University of Washington, only if
--                    people-08 will link someone to them
--  15   people-05    11 NIH program staff -> their institute or NIH (+ the NIMH, NINDS, NIDCD, NIDA nodes)
--  16   people-07    16 members -> the organization their institution names
--   3   people-08    MacAskill -> UCL; Estes and St. John -> University of Washington
--   8   notices-01   6 announcements' organization copied onto their spine rows (+ BBQS Consortium, SfN)
--   1   notices-02   event 'BBQS MIT Workshop 2026' -> BBQS Consortium
--  15   notices-04   13 funding calls -> their issuer, read off the FON (+ NIH OD Common Fund, Simons)
--   1   tools-02     Lightning Pose -> Columbia (its own description)
--   1   tools-03     Psych-DS -> MIT (SFN2025.tsx; checked against Melissa Kline Struhl's membership)
-- 0-4   datasets-D06 EMBER collections 000469-000471, 000474 -> R24MH136632, only where the DANDI
--                    contact or a contributor is on R24MH136632's roster (the live contacts decide)
--   1   datasets-D07 000607 'Four-choice reversal digging task' -> R34DA062119 (ARC, Wilbrecht)
--   0+  datasets-D08 datasets whose own DANDI record names a BBQS award the sync's parser dropped
--                    (none known today)
--   0   tools-04     create public.resource_links (audited, RLS, anon-readable)
--   0   tools-05     record 5 evidenced links in it: 6 nodes once kg/bbqs_kg.py reads the table
--   0+  tools-06     device_class_crosswalk rows for isolated device categories (live evidence decides)
--   Read-only, they write nothing: datasets-D00 (which ember sync is live), people-10 (both Walker
--   records), people-01-report and people-11 (orphans left; the 4 name-only people), datasets-D10
--   (datasets still unlinked, with their DANDI contact), notices-05 (participating-only funders),
--   tools-10 (device-category reach, unmapped buckets, tools still unlinked).
--   OPTIONAL blocks (section 3) are commented out; each starts with the question a curator must
--   answer first. To apply one, uncomment it and run the whole file again (dry run first).
--
-- EFFECT, simulated on the 11-04 export (tested on a replica of the schema with a synthetic copy of
-- the rows touched): 189 isolated -> 188 by a plain re-export (the Sharif stub was deleted live on
-- 11-06) -> 70-75 with this script (D05/D06/D08 depend on live DANDI data) -> 64-69 once the
-- exporter reads resource_links (tools-11) -> about 47-55 once #512's exporter half merges.
--
-- NOT FIXED BY SQL (who)
--   * Anibal Heinsfeld, Chaoyi Zhang, Omid Sharafi, Latane Bullock (a name only) and Jeffrey Walker
--     (same person as Jeffery Walker?): a curator, asking them or their PI (report rows people-10/11).
--   * NCCIH, NEI, NIA, NIAAA, NIBIB, ORWH, OBSSR, NICHD, Empire AI (named only as participating
--     funders) and Anipose, Bonsai, LabStreamingLayer, MoSeq, Open Ephys, OpenFace, OpenPose, SLEAP
--     (linked live by project_software_tools): a developer merges #512's exporter half.
--   * DLC Model Zoo, SuperAnimal-Quadruped-80K, SuperAnimal-TopViewMouse-5K, DLC Leaderboard,
--     DeepLabCut, VCL Benchmark: a developer applies the resource_links exporter patch (tools-11).
--   * Lab datasets with no BBQS award on their DANDI record (D10 lists them, with the contact):
--     the project team adds the award on EMBER-DANDI (the nightly sync links it) or tells a curator.
--   * Device categories: imu, lidar_radar, neural_imaging need only a fresh export with the HEAD
--     exporter; depth_camera, survey_task, ppg need a questionnaire-label mapping (developer, curator).
--   * Tools with no known user or maker (BENTO, Dynestyx, fastplotlib, idtracker.ai, SimBA, CEBRA,
--     DeepPoseKit, senselab, SSL, Vocalocator, Vocalocator-SSL, DLC 3D Pose Protocol, DLC Organization,
--     Animal Pose Leaderboard); MARS, DeepSqueak, JAABA, DLC Benchmarks need a species parse in the
--     exporter: project teams, a curator, a developer.
--   * What keeps making orphans (onboard_member's MERGE and seed-consortium delete or insert only one
--     of the two rows) and new calls, announcements and jobs with no spine row: a developer.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;
-- Principle X: a SQL-editor write has no auth.uid(), so the script names itself before any write.
-- Both settings are transaction-local; the runner re-declares them before every block.
SELECT public.set_actor('migration:link_isolated_nodes');
SELECT public.set_source_class('curator_fill');

-- ┌──────────────────────────────── DRY-RUN SWITCH (the one line to edit) ────────────────────────────────┐
--   'on'  = rehearse: run every block, show the report, then roll everything back (nothing changes).
--   'off' = apply: the same run, committed.  Any other value is treated as 'on'.
SELECT set_config('bbqs.dry_run', 'on', true);
-- └──────────────────────────────────────────────────────────────────────────────────────────────────────┘

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 0. SETUP: the report table and the helpers. Temp objects only (schema pg_temp): nothing in this
--    section writes to a real table. Dropped first, so a second run in the same editor session
--    starts from a clean report.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS pg_temp.kg_fix_report;
-- One row per decision a block takes, plus one summary row per block and one RESULT row. The block
-- and its position come from the runner (bbqs.block / bbqs.block_ord), so a helper only names the
-- decision. The last statement of this script prints it (pg_temp.kg_report()).
CREATE TEMP TABLE kg_fix_report (
  seq     bigserial PRIMARY KEY,
  ord     int  NOT NULL DEFAULT coalesce(nullif(current_setting('bbqs.block_ord', true), '')::int, 0),
  block   text NOT NULL DEFAULT coalesce(nullif(current_setting('bbqs.block', true), ''), 'setup'),
  kind    text NOT NULL DEFAULT 'decision' CHECK (kind IN ('result', 'summary', 'decision')),
  item    text NOT NULL,
  target  text,
  outcome text NOT NULL CHECK (outcome IN ('done', 'noop', 'skipped', 'report', 'error', 'optional')),
  n_rows  bigint,
  detail  text
);

-- Run one block: name it, re-declare the actor (Principle X), run it in its own savepoint, then
-- write its summary row. The row count is read back from the audit trail itself: every data_audit_log
-- row this transaction wrote since the block began (occurred_at = now() is this transaction's start
-- time), plus the two tables that have no audit trigger (knowledge_embeddings, species_aliases),
-- plus the field_provenance claims recorded. An error inside a block is caught here, the block's own
-- writes are rolled back to its savepoint, and an 'error' row is written: the runner then rolls the
-- WHOLE script back (a real run never commits a partial result).
CREATE OR REPLACE FUNCTION pg_temp.kg_run(_ord int, _block text, _title text, _fn text)
RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  _a0 bigint; _p0 bigint; _k0 bigint; _s0 bigint; _q0 bigint;
  _k1 bigint; _s1 bigint; _np bigint; _nw bigint;
  _writes text; _other text; _outs text; _agg text;
  _st text; _msg text; _ctx text;
BEGIN
  PERFORM set_config('bbqs.block', _block, true);
  PERFORM set_config('bbqs.block_ord', _ord::text, true);
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  SELECT coalesce(max(id), 0) INTO _a0 FROM public.data_audit_log;
  SELECT coalesce(max(id), 0) INTO _p0 FROM public.field_provenance;
  SELECT count(*) INTO _k0 FROM public.knowledge_embeddings;
  SELECT count(*) INTO _s0 FROM public.species_aliases;
  SELECT coalesce(max(seq), 0) INTO _q0 FROM pg_temp.kg_fix_report;

  BEGIN
    EXECUTE format('SELECT %s()', _fn);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS _st = RETURNED_SQLSTATE, _msg = MESSAGE_TEXT, _ctx = PG_EXCEPTION_CONTEXT;
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES (_title, 'whole block', 'error',
            format('%s: %s. This block''s writes were rolled back, and a real run changes nothing while any error stands. Context: %s',
                   _st, _msg, left(regexp_replace(_ctx, '\s+', ' ', 'g'), 240)));
  END;
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');

  SELECT coalesce(string_agg(format('%s %s %s', t.table_name, t.operation, t.n), ', '
                             ORDER BY t.table_name, t.operation), 'none'),
         coalesce(sum(t.n), 0)
    INTO _writes, _nw
    FROM (SELECT d.table_name, d.operation, count(*) AS n
            FROM public.data_audit_log d
           WHERE d.id > _a0 AND d.occurred_at = now()
           GROUP BY 1, 2) t;
  -- Any audit row of this transaction that does NOT carry the script's label would be a Principle X
  -- gap; none is expected (every block re-declares set_actor).
  SELECT string_agg(DISTINCT coalesce(d.actor_label, '(null)'), ', ') INTO _other
    FROM public.data_audit_log d
   WHERE d.id > _a0 AND d.occurred_at = now()
     AND d.actor_label IS DISTINCT FROM 'migration:link_isolated_nodes';
  SELECT count(*) INTO _k1 FROM public.knowledge_embeddings;
  SELECT count(*) INTO _s1 FROM public.species_aliases;
  SELECT count(*) INTO _np FROM public.field_provenance WHERE id > _p0;

  SELECT string_agg(format('%s %s', o.outcome, o.n), ' · ' ORDER BY o.pos),
         CASE WHEN bool_or(o.outcome = 'error') THEN 'error'
              WHEN bool_or(o.outcome = 'done') THEN 'done'
              WHEN bool_or(o.outcome = 'skipped') THEN 'skipped'
              WHEN bool_or(o.outcome = 'noop') THEN 'noop'
              ELSE 'report' END
    INTO _outs, _agg
    FROM (SELECT r.outcome, count(*) AS n,
                 array_position(ARRAY['done', 'noop', 'skipped', 'report', 'error'], r.outcome) AS pos
            FROM pg_temp.kg_fix_report r
           WHERE r.seq > _q0 AND r.kind = 'decision'
           GROUP BY r.outcome) o;

  INSERT INTO pg_temp.kg_fix_report (kind, item, outcome, n_rows, detail)
  VALUES ('summary', _title || ' [' || coalesce(_outs, 'no decisions') || ']', coalesce(_agg, 'report'),
          _nw + abs(_k1 - _k0) + abs(_s1 - _s0),
          format('audited writes: %s; not audited: knowledge_embeddings %s, species_aliases %s; field_provenance claims recorded: %s%s',
                 _writes, CASE WHEN _k1 > _k0 THEN '+' ELSE '' END || (_k1 - _k0),
                 CASE WHEN _s1 > _s0 THEN '+' ELSE '' END || (_s1 - _s0), _np,
                 CASE WHEN _other IS NOT NULL THEN '; WARNING: audit rows labelled ' || _other ELSE '' END));
END
$fn$;

-- An OPTIONAL block runs only if its function was defined in this run, i.e. a curator answered its
-- question and the block was uncommented in the OPTIONAL section. Otherwise it is listed, not run.
CREATE OR REPLACE FUNCTION pg_temp.kg_run_optional(_ord int, _block text, _title text, _fn text, _question text)
RETURNS void LANGUAGE plpgsql AS
$fn$
BEGIN
  IF to_regprocedure(_fn || '()') IS NULL THEN
    PERFORM set_config('bbqs.block', _block, true);
    PERFORM set_config('bbqs.block_ord', _ord::text, true);
    INSERT INTO pg_temp.kg_fix_report (kind, item, outcome, n_rows, detail)
    VALUES ('summary', _title || ' [OPTIONAL: not run]', 'optional', 0,
            'Commented out in the OPTIONAL section. A curator answers first: ' || _question);
    RETURN;
  END IF;
  PERFORM pg_temp.kg_run(_ord, _block, _title || ' (OPTIONAL, uncommented)', _fn);
END
$fn$;

-- The RESULT row: what happened, totals, and how to flip the switch.
CREATE OR REPLACE FUNCTION pg_temp.kg_result(_dry boolean)
RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  _sw   text := coalesce(current_setting('bbqs.dry_run', true), '(unset)');
  _tot  bigint;
  _dec  text;
  _blk  int;
  _opt  int;
  _err  int;
BEGIN
  SELECT coalesce(sum(n_rows), 0), count(*) FILTER (WHERE outcome <> 'optional'), count(*) FILTER (WHERE outcome = 'optional')
    INTO _tot, _blk, _opt FROM pg_temp.kg_fix_report WHERE kind = 'summary';
  SELECT string_agg(format('%s %s', o.outcome, o.n), ', ' ORDER BY o.pos), coalesce(sum(o.n) FILTER (WHERE o.outcome = 'error'), 0)
    INTO _dec, _err
    FROM (SELECT outcome, count(*) AS n,
                 array_position(ARRAY['done', 'noop', 'skipped', 'report', 'error'], outcome) AS pos
            FROM pg_temp.kg_fix_report WHERE kind = 'decision' GROUP BY outcome) o;
  PERFORM set_config('bbqs.block', 'RESULT', true);
  PERFORM set_config('bbqs.block_ord', '0', true);
  INSERT INTO pg_temp.kg_fix_report (kind, item, outcome, n_rows, detail)
  VALUES ('result',
          CASE WHEN _dry THEN 'DRY RUN: every block ran, then everything was rolled back. NOTHING WAS CHANGED.'
               ELSE 'APPLIED: committed as one transaction under migration:link_isolated_nodes.' END,
          CASE WHEN _err > 0 THEN 'error' WHEN _dry THEN 'report' ELSE 'done' END,
          _tot,
          format('%s block(s) ran, %s optional block(s) not run; decisions: %s; rows%s written: %s (summary rows below; rows = audited writes + search-index and alias rows). ',
                 _blk, _opt, coalesce(_dec, 'none'), CASE WHEN _dry THEN ' that WOULD be' ELSE '' END, _tot)
          || CASE WHEN _dry AND _err > 0 THEN format('%s ERROR(S): a real run would change nothing until they are fixed (rows marked error). ', _err) ELSE '' END
          || CASE WHEN _dry THEN format('The dry-run switch is %L. To apply: change it to ''off'' in the line  SELECT set_config(''bbqs.dry_run'', ''on'', true);  near the top, and run the whole script again.', _sw)
                  ELSE 'Running it again changes nothing (every block reports 0 rows). Next: re-export the graph (see VERIFY in the header).' END);
END
$fn$;

-- The report the editor shows (the script's last statement): RESULT first, then one summary row per
-- block in run order, then every decision in the order it was taken.
CREATE OR REPLACE FUNCTION pg_temp.kg_report()
RETURNS TABLE (block text, action text, "rows" bigint, detail text)
LANGUAGE sql STABLE AS
$fn$
  SELECT r.block,
         CASE WHEN r.kind = 'decision'
              THEN r.outcome || ' · ' || r.item || coalesce(' · ' || r.target, '')
              ELSE r.item END,
         r.n_rows,
         r.detail
    FROM pg_temp.kg_fix_report r
   ORDER BY CASE r.kind WHEN 'result' THEN 0 WHEN 'summary' THEN 1 ELSE 2 END, r.ord, r.seq
$fn$;

-- Optional blocks are defined only when uncommented below; drop any left from an earlier run
-- in this session, so only what is uncommented THIS time can run.
DROP FUNCTION IF EXISTS pg_temp.kg_o_people_04();
DROP FUNCTION IF EXISTS pg_temp.kg_o_people_09();
DROP FUNCTION IF EXISTS pg_temp.kg_o_people_10();
DROP FUNCTION IF EXISTS pg_temp.kg_o_datasets_o1();
DROP FUNCTION IF EXISTS pg_temp.kg_o_datasets_o2a();
DROP FUNCTION IF EXISTS pg_temp.kg_o_datasets_o2b();
DROP FUNCTION IF EXISTS pg_temp.kg_o_datasets_o3();
DROP FUNCTION IF EXISTS pg_temp.kg_o_datasets_o4();
DROP FUNCTION IF EXISTS pg_temp.kg_o_datasets_o5();
DROP FUNCTION IF EXISTS pg_temp.kg_o_notices_06();
DROP FUNCTION IF EXISTS pg_temp.kg_o_tools_07();
DROP FUNCTION IF EXISTS pg_temp.kg_o_tools_08();
DROP FUNCTION IF EXISTS pg_temp.kg_o_tools_09();

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. HELPERS used by several blocks (pg_temp, gone at the end of the session)
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- Whitespace- and case-folded name: the comparison onboard_member uses for RePORTER stubs
-- (20260810130000: lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g'))).
CREATE OR REPLACE FUNCTION pg_temp.kg_norm(_s text) RETURNS text
LANGUAGE sql IMMUTABLE AS
$fn$ SELECT lower(regexp_replace(btrim(coalesce(_s, '')), '[[:space:]]+', ' ', 'g')) $fn$;

-- Rows that reference _id through ANY declared foreign key to _target, except the
-- "schema.table.column" names in _skip. The scan 20261106130000 step 3 uses, read from
-- pg_constraint so a table types.ts does not know about (mcp_usage_log, #512's link tables, ...)
-- is still seen. Returns '' when nothing references the row.
CREATE OR REPLACE FUNCTION pg_temp.kg_fk_refs(_target regclass, _id uuid, _skip text[] DEFAULT '{}')
RETURNS text LANGUAGE plpgsql AS
$fn$
DECLARE c record; _n bigint; _refs text := '';
BEGIN
  FOR c IN
    SELECT format('%I.%I', n.nspname, cl.relname) AS tbl, a.attname AS col,
           n.nspname || '.' || cl.relname || '.' || a.attname AS qual
      FROM pg_constraint k
      JOIN pg_class cl     ON cl.oid = k.conrelid
      JOIN pg_namespace n  ON n.oid = cl.relnamespace
      JOIN pg_attribute a  ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
     WHERE k.contype = 'f' AND k.confrelid = _target
  LOOP
    CONTINUE WHEN c.qual = ANY (_skip);
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', c.tbl, c.col) INTO _n USING _id;
    IF _n > 0 THEN _refs := _refs || format('%s=%s ', c.qual, _n); END IF;
  END LOOP;
  RETURN btrim(_refs);
END
$fn$;

-- Link one person (by their resources spine id, = the KG node id) to one organization (by its
-- spine id, or by exact name when _org_rid is NULL, for an org this script creates).
-- Every guard failure is a 'skipped' report row, never an exception: one bad row must not stop
-- the other links. investigator_organizations is keyed (investigator_id, organization_id), so
-- ON CONFLICT DO NOTHING is the house pattern (20260910120000, 20260831130000, #517 block 11).
CREATE OR REPLACE FUNCTION pg_temp.kg_link_org(
  _item text, _rid uuid, _label text, _org_rid uuid, _org_label text,
  _expect text, _reject text, _evidence text, _allow_other_orgs boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  _tgt  text := _label || ' -> ' || _org_label;
  _inv  public.investigators%ROWTYPE;
  _org  uuid;
  _n    int;
  _have text;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');

  -- 1. The person: the exported spine row, still an investigator, still named as exported.
  IF NOT EXISTS (SELECT 1 FROM public.resources r
                  WHERE r.id = _rid AND r.resource_type = 'investigator'
                    AND pg_temp.kg_norm(r.name) = pg_temp.kg_norm(_label)) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('spine row %s is gone, retyped or renamed', _rid));
    RETURN;
  END IF;
  SELECT count(*) INTO _n FROM public.investigators WHERE resource_id = _rid;
  IF _n <> 1 THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped',
            format('%s investigators rows point at spine %s (expected 1)%s', _n, _rid,
                   CASE WHEN _n = 0 THEN ' -- it is an orphan; see the people-01-report rows' ELSE '' END));
    RETURN;
  END IF;
  SELECT * INTO _inv FROM public.investigators WHERE resource_id = _rid;

  -- 2. The row's own institution text (anon-hidden, so not in the export) must not contradict
  --    the repo evidence. Empty is accepted: the evidence is then the repo source named below.
  IF nullif(btrim(_inv.institution), '') IS NOT NULL
     AND (_inv.institution !~* _expect OR (_reject IS NOT NULL AND _inv.institution ~* _reject)) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped',
            format('the row''s institution %L contradicts the evidence (%s); a curator decides', _inv.institution, _evidence));
    RETURN;
  END IF;

  -- 3. The organization: its spine row named as exported, with an organizations row on it.
  IF _org_rid IS NOT NULL THEN
    SELECT o.id INTO _org
      FROM public.organizations o JOIN public.resources r ON r.id = o.resource_id
     WHERE o.resource_id = _org_rid AND r.resource_type = 'organization'
       AND pg_temp.kg_norm(r.name) = pg_temp.kg_norm(_org_label)
     ORDER BY o.created_at LIMIT 1;
  ELSE
    SELECT o.id INTO _org
      FROM public.organizations o JOIN public.resources r ON r.id = o.resource_id
     WHERE pg_temp.kg_norm(o.name) = pg_temp.kg_norm(_org_label) AND r.resource_type = 'organization'
     ORDER BY o.created_at LIMIT 1;
  END IF;
  IF _org IS NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped',
            format('organization %s (%s) is gone, renamed, or has no organizations row on a spine row', coalesce(_org_rid::text, 'by name'), _org_label));
    RETURN;
  END IF;

  -- 4. Still unaffiliated: this is the isolation being fixed. An existing link to the SAME org is
  --    a no-op; a link to another org means a curator already decided, so do not add a second.
  IF EXISTS (SELECT 1 FROM public.investigator_organizations
              WHERE investigator_id = _inv.id AND organization_id = _org) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'noop', 'link already present');
    RETURN;
  END IF;
  SELECT string_agg(o.name, '; ' ORDER BY o.name) INTO _have
    FROM public.investigator_organizations io JOIN public.organizations o ON o.id = io.organization_id
   WHERE io.investigator_id = _inv.id;
  IF _have IS NOT NULL AND NOT _allow_other_orgs THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'already affiliated with ' || _have || '; not adding a second organization');
    RETURN;
  END IF;

  INSERT INTO public.investigator_organizations (investigator_id, organization_id)
  VALUES (_inv.id, _org)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _tgt, CASE WHEN _n = 1 THEN 'done' ELSE 'noop' END,
          format('%s; evidence: %s; row institution: %s',
                 CASE WHEN _n = 1 THEN 'linked' ELSE 'link already present' END, _evidence,
                 coalesce(quote_literal(nullif(btrim(_inv.institution), '')), '(empty)')));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _tgt, 'error', SQLSTATE || ': ' || SQLERRM);
END
$fn$;

-- The organizations.id behind an exported organization node. organizations.id is not in the
-- export, so it is found by the node id (= organizations.resource_id) and the exported name; if
-- the spine row was re-keyed, by the folded name, but only when exactly one organization that has
-- a spine row carries it. NULL when neither finds one (the caller reports and skips).
CREATE OR REPLACE FUNCTION pg_temp.kg_org_of(_org_rid uuid, _org_label text) RETURNS uuid
LANGUAGE plpgsql STABLE AS
$fn$
DECLARE _ids uuid[];
BEGIN
  SELECT array_agg(o.id ORDER BY o.created_at) INTO _ids
    FROM public.organizations o JOIN public.resources r ON r.id = o.resource_id
   WHERE o.resource_id = _org_rid AND r.resource_type::text = 'organization'
     AND (pg_temp.kg_norm(o.name) = pg_temp.kg_norm(_org_label)
          OR pg_temp.kg_norm(r.name) = pg_temp.kg_norm(_org_label));
  IF cardinality(_ids) >= 1 THEN RETURN _ids[1]; END IF;
  SELECT array_agg(o.id) INTO _ids
    FROM public.organizations o JOIN public.resources r ON r.id = o.resource_id
   WHERE pg_temp.kg_norm(o.name) = pg_temp.kg_norm(_org_label) AND r.resource_type::text = 'organization';
  RETURN CASE WHEN cardinality(_ids) = 1 THEN _ids[1] END;
END
$fn$;

-- Folded person-name tokens: lower-case runs of letters, 2+ characters, as a sorted set.
-- 'Wilbrecht, Linda' (DANDI's "Last, First") and 'Linda Wilbrecht' (investigators.name) give the
-- same set; initials such as 'D' or 'W.' drop out.
CREATE OR REPLACE FUNCTION pg_temp.kg_ds_tokens(_s text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS
$fn$
  SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}'::text[])
    FROM regexp_split_to_table(lower(coalesce(_s, '')), '[^[:alpha:]]+') AS t
   WHERE length(t) >= 2
$fn$;

-- The ORCID iD inside any common spelling (bare, orcid.org/..., https://orcid.org/...), else NULL.
CREATE OR REPLACE FUNCTION pg_temp.kg_ds_orcid(_s text) RETURNS text
LANGUAGE sql IMMUTABLE AS
$fn$ SELECT upper(substring(coalesce(_s, '') from '[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9Xx]')) $fn$;

-- Who on _grant_id's roster (grant_investigators: the system of record for "who is on this
-- project", Principle III) the dandiset's own DANDI record names, as contact_name or as a Person
-- contributor in raw->'contributor', matched by ORCID or by full name. NULL when nobody matches.
CREATE OR REPLACE FUNCTION pg_temp.kg_ds_roster_match(_grant_id uuid, _contact text, _raw jsonb)
RETURNS text LANGUAGE sql STABLE AS
$fn$
  WITH named AS (
    SELECT _contact AS name, NULL::text AS orcid
    UNION ALL
    SELECT c ->> 'name', pg_temp.kg_ds_orcid(c ->> 'identifier')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(_raw -> 'contributor') = 'array'
                                     THEN _raw -> 'contributor' ELSE '[]'::jsonb END) AS c
     WHERE coalesce(c ->> 'schemaKey', 'Person') = 'Person'
  ), roster AS (
    SELECT DISTINCT i.name, pg_temp.kg_ds_orcid(i.orcid) AS orcid, pg_temp.kg_ds_tokens(i.name) AS toks
      FROM public.grant_investigators gi
      JOIN public.investigators i ON i.id = gi.investigator_id
     WHERE gi.grant_id = _grant_id
  )
  SELECT string_agg(DISTINCT r.name || CASE WHEN n.orcid IS NOT NULL AND n.orcid = r.orcid
                                            THEN ' (by ORCID)' ELSE ' (by name)' END, '; ')
    FROM roster r
    JOIN named n
      ON (n.orcid IS NOT NULL AND n.orcid = r.orcid)
      OR (cardinality(pg_temp.kg_ds_tokens(n.name)) >= 2
          AND pg_temp.kg_ds_tokens(n.name) <@ r.toks)
$fn$;

-- set_dandiset_hidden(_hidden => true) for ONE dandiset, minus its auth.uid() gate (the editor has
-- no JWT; the actor is the set_actor label, and hidden_by = auth.uid() stays NULL there). The same
-- writes in the same order as 20261105120000:47-54: hidden / hidden_reason / hidden_by / hidden_at
-- and resource_id = NULL on the mirror row, then DELETE the resources row (audited by
-- trg_audit_resources). Plus the chat-index copy of the spine row, as 20261106130000 step 2 does,
-- because embed-knowledge only ever upserts. Every guard failure is a 'skipped' report row, never
-- an exception, and any error rolls back this one dandiset only (the EXCEPTION block's savepoint).
CREATE OR REPLACE FUNCTION pg_temp.kg_ds_hide(
  _item text, _dandiset_id text, _export_rid uuid, _name_re text, _reason text,
  _allow_linked boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  _d     record;
  _tgt   text := _dandiset_id;
  _links text;
  _rtype text;
  _refs  text;
  _ke    int := 0;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');

  SELECT d.id, d.name, d.resource_id, d.hidden, d.file_count, d.award_numbers INTO _d
    FROM public.dandisets d
   WHERE d.instance = 'ember' AND d.dandiset_id = _dandiset_id
     FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'not in the ember mirror (public.dandisets)');
    RETURN;
  END IF;
  _tgt := _dandiset_id || ' ' || _d.name;

  -- Same upload as the export named? A renamed dandiset may have become real data.
  IF _d.name !~* _name_re THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('mirror name is now %L (expected ~* %L); a curator decides', _d.name, _name_re));
    RETURN;
  END IF;

  IF _d.hidden AND _d.resource_id IS NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'noop', 'already hidden, no resources row');
    RETURN;
  END IF;

  -- Linked since the export? Hiding drops the node and its funded_datasets edge (the
  -- grant_dandisets row itself stays, and an unhide restores both), so it needs a person's yes.
  SELECT string_agg(g.grant_number || ' (' || gd.match_source || ')', ', ' ORDER BY g.grant_number)
    INTO _links
    FROM public.grant_dandisets gd JOIN public.grants g ON g.id = gd.grant_id
   WHERE gd.dandiset_id = _d.id;
  IF NOT _allow_linked AND (_links IS NOT NULL OR coalesce(cardinality(_d.award_numbers), 0) > 0) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped',
            format('now linked (grant_dandisets: %s; DANDI awards: %s); not hiding a linked dataset',
                   coalesce(_links, 'none'), coalesce(array_to_string(_d.award_numbers, ', '), 'none')));
    RETURN;
  END IF;

  IF _d.resource_id IS NOT NULL THEN
    SELECT r.resource_type::text INTO _rtype FROM public.resources r WHERE r.id = _d.resource_id;
    IF _rtype IS DISTINCT FROM 'dataset' AND _rtype IS NOT NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _tgt, 'skipped', format('resources row %s is a %s, not a dataset', _d.resource_id, _rtype));
      RETURN;
    END IF;
    -- Anything else pointing at the spine row (entity_comments = someone's words, a detail table,
    -- a newer link table) stops the delete. dandisets.resource_id is cleared below; the
    -- knowledge_embeddings copy is deleted below.
    _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _d.resource_id,
               ARRAY['public.dandisets.resource_id', 'public.knowledge_embeddings.resource_id']);
    IF _refs <> '' THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _tgt, 'skipped', format('resources row %s is still referenced (%s); not deleting it', _d.resource_id, _refs));
      RETURN;
    END IF;
    -- The skip above covers THIS mirror row only: another dandiset on the same spine row would lose
    -- its node through dandisets_resource_id_fkey ON DELETE SET NULL.
    IF EXISTS (SELECT 1 FROM public.dandisets o WHERE o.resource_id = _d.resource_id AND o.id <> _d.id) THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _tgt, 'skipped', format('another mirror row shares resources row %s; a curator decides', _d.resource_id));
      RETURN;
    END IF;
  END IF;

  UPDATE public.dandisets
     SET hidden = true, hidden_reason = btrim(_reason), hidden_by = auth.uid(), hidden_at = now(),
         resource_id = NULL
   WHERE id = _d.id;

  IF _d.resource_id IS NOT NULL THEN
    DELETE FROM public.knowledge_embeddings
     WHERE resource_id = _d.resource_id OR source_id = _d.resource_id::text;
    GET DIAGNOSTICS _ke = ROW_COUNT;
    DELETE FROM public.resources WHERE id = _d.resource_id;
  END IF;

  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _tgt, 'done',
          format('hidden (%s); %s%s', _reason,
                 CASE WHEN _d.resource_id IS NULL THEN 'it had no resources row'
                      ELSE format('resources row %s deleted, %s search-index row(s) removed', _d.resource_id, _ke) END,
                 CASE WHEN _d.resource_id IS DISTINCT FROM _export_rid
                      THEN format(' (the 2026-11-04 export node was %s)', _export_rid) ELSE '' END));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _tgt, 'error', SQLSTATE || ': ' || SQLERRM);
END
$fn$;

-- One curator grant_dandisets row (grant -> dandiset, match_source 'curator'), the route #517
-- block 10 used for 000207 and 000598 on 2026-11-03. The exporter turns it into
-- (Project) bbqs:funded_datasets (Dataset) via grants.resource_id and dandisets.resource_id
-- (kg/bbqs_kg.py:395-398). ember-dandiset-sync deletes only match_source = 'award_number' rows
-- (index.ts:185-189), so a curator row survives every nightly run.
--   _require 'roster'          the dandiset's contact or a Person contributor is on the grant's roster
--   _require 'contact:<regex>' contact_name ~* <regex> AND that person is on the grant's roster
--   _require 'curator'         a person said yes (optional blocks only); the roster match is recorded if any
CREATE OR REPLACE FUNCTION pg_temp.kg_ds_link(
  _item text, _dandiset_id text, _export_rid uuid, _name_re text, _grant_number text,
  _require text, _evidence text)
RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  _d     record;
  _g     record;
  _tgt   text := _dandiset_id || ' -> ' || _grant_number;
  _links text;
  _who   text;
  _gd    uuid;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');

  SELECT d.id, d.name, d.resource_id, coalesce(d.hidden, false) AS hidden, d.file_count,
         d.award_numbers, d.contact_name, d.raw
    INTO _d
    FROM public.dandisets d
   WHERE d.instance = 'ember' AND d.dandiset_id = _dandiset_id;
  IF NOT FOUND THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'not in the ember mirror (public.dandisets)');
    RETURN;
  END IF;
  _tgt := _dandiset_id || ' ' || _d.name || ' -> ' || _grant_number;

  IF _d.name !~* _name_re THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('mirror name is now %L (expected ~* %L); a curator decides', _d.name, _name_re));
    RETURN;
  END IF;
  IF _d.hidden OR _d.resource_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.resources r WHERE r.id = _d.resource_id AND r.resource_type = 'dataset') THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'hidden, or has no dataset resources row: there is no KG node to link');
    RETURN;
  END IF;

  SELECT g.id, g.grant_number, g.resource_id INTO _g FROM public.grants g WHERE g.grant_number = _grant_number;
  IF NOT FOUND OR _g.resource_id IS NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('grant %s missing or without a spine row (no Project node)', _grant_number));
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.grant_dandisets WHERE grant_id = _g.id AND dandiset_id = _d.id) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _tgt, 'noop', 'link already present');
    RETURN;
  END IF;
  -- Still unlinked: this is the isolation being fixed. A link to another grant, or an award on the
  -- DANDI record, is someone else's (or the archive's) answer; do not add a second project.
  SELECT string_agg(g.grant_number || ' (' || gd.match_source || ')', ', ' ORDER BY g.grant_number)
    INTO _links
    FROM public.grant_dandisets gd JOIN public.grants g ON g.id = gd.grant_id
   WHERE gd.dandiset_id = _d.id;
  IF _links IS NOT NULL OR coalesce(cardinality(_d.award_numbers), 0) > 0 THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped',
            format('already linked (grant_dandisets: %s; DANDI awards: %s); not adding %s',
                   coalesce(_links, 'none'), coalesce(array_to_string(_d.award_numbers, ', '), 'none'), _grant_number));
    RETURN;
  END IF;

  IF _require = 'roster' THEN
    _who := pg_temp.kg_ds_roster_match(_g.id, _d.contact_name, _d.raw);
    IF _who IS NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _tgt, 'skipped',
              format('DANDI contact %L and the record''s Person contributors are not on %s''s roster; a curator decides (the optional block links it on a yes)',
                     coalesce(_d.contact_name, '(none)'), _grant_number));
      RETURN;
    END IF;
  ELSIF _require LIKE 'contact:%' THEN
    IF coalesce(_d.contact_name, '') !~* substr(_require, 9) THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _tgt, 'skipped',
              format('DANDI contact is %L, not ~* %L as the evidence says; a curator decides',
                     coalesce(_d.contact_name, '(none)'), substr(_require, 9)));
      RETURN;
    END IF;
    _who := pg_temp.kg_ds_roster_match(_g.id, _d.contact_name, NULL);
    IF _who IS NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _tgt, 'skipped', format('contact %L is not on %s''s roster', _d.contact_name, _grant_number));
      RETURN;
    END IF;
  ELSIF _require = 'curator' THEN
    _who := coalesce(pg_temp.kg_ds_roster_match(_g.id, _d.contact_name, _d.raw), 'nobody on the roster (linked on a curator''s yes)');
  ELSE
    RAISE EXCEPTION 'unknown _require %', _require;
  END IF;

  INSERT INTO public.grant_dandisets (grant_id, dandiset_id, match_source)
  VALUES (_g.id, _d.id, 'curator')
  ON CONFLICT (grant_id, dandiset_id) DO NOTHING
  RETURNING id INTO _gd;
  IF _gd IS NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _tgt, 'noop', 'link already present');
    RETURN;
  END IF;

  -- The AFTER INSERT recorder stamps each cell at curator_fill; this says WHY, which it cannot know
  -- (the confirm_species_candidate pattern, 20260822120000:132-136).
  PERFORM public.record_field_provenance(
    'grant_dandisets', _gd, 'match_source', 'curator_fill', 'linked_by_curator',
    NULL, 'EMBER-DANDI ' || _dandiset_id || ' (dandisets.contact_name, raw.contributor) + grant_investigators',
    'curator',
    format('%s DANDI contact: %s. On the %s roster: %s.', _evidence,
           coalesce(_d.contact_name, '(none)'), _grant_number, _who));

  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _tgt, 'done',
          format('grant_dandisets row added (curator); roster match: %s%s', _who,
                 CASE WHEN _d.resource_id IS DISTINCT FROM _export_rid
                      THEN format(' (node is now %s; the 2026-11-04 export had %s)', _d.resource_id, _export_rid) ELSE '' END));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _tgt, 'error', SQLSTATE || ': ' || SQLERRM);
END
$fn$;

-- ── tools helpers ──────────────────────────────────────────────────────────────────────────────
-- Fill one spine row's organization (resources.organization_id; the exporter writes it as
-- part_of_org, kg/bbqs_kg.py:154-155) where it is empty. _rid/_label/_type name the exported node,
-- _org_rid/_org_label the exported organization node (organizations.id is not in the export, so
-- kg_org_of finds it). _evidence_ok is the evidence re-checked against the live data by the caller.
-- Never overwrites: a different organization already set is a curator's choice and is reported.
CREATE OR REPLACE FUNCTION pg_temp.kg_tools_set_org(
  _item text, _rid uuid, _label text, _type text, _org_rid uuid, _org_label text,
  _evidence_ok boolean, _evidence text)
RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  _tgt  text := _label || ' -> ' || _org_label;
  _r    public.resources%ROWTYPE;
  _org  uuid;
  _have text;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');

  SELECT * INTO _r FROM public.resources WHERE id = _rid;
  IF NOT FOUND OR _r.resource_type::text <> _type
     OR pg_temp.kg_norm(_r.name) <> pg_temp.kg_norm(_label) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('spine row %s is gone, retyped or renamed (expected %s %L)', _rid, _type, _label));
    RETURN;
  END IF;
  _org := pg_temp.kg_org_of(_org_rid, _org_label);
  IF _org IS NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('organization node %s (%s) has no organizations row on its spine row', _org_rid, _org_label));
    RETURN;
  END IF;
  IF _r.organization_id = _org THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _tgt, 'noop', 'organization already set');
    RETURN;
  END IF;
  IF _r.organization_id IS NOT NULL THEN
    SELECT o.name INTO _have FROM public.organizations o WHERE o.id = _r.organization_id;
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('already part of %s; not overwriting it', coalesce(_have, _r.organization_id::text)));
    RETURN;
  END IF;
  IF NOT coalesce(_evidence_ok, false) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'the evidence no longer holds in the live data: ' || _evidence);
    RETURN;
  END IF;
  -- An optional line uncommented with its <placeholder> still in place records nothing.
  IF _evidence ~ '<[^<>]+>' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'the evidence is still a placeholder: ' || _evidence || '; write where the link is stated, then run again');
    RETURN;
  END IF;

  UPDATE public.resources SET organization_id = _org WHERE id = _rid AND organization_id IS NULL;
  INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _tgt, 'done', _evidence);
END
$fn$;

-- Record one curated link between two spine rows in public.resource_links (block tools-04). Both ends must
-- still be the exported nodes (same resource_type, same folded name); _evidence_ok re-checks the
-- evidence against the live data. Every guard failure is a 'skipped' report row, never an exception.
CREATE OR REPLACE FUNCTION pg_temp.kg_tools_link(
  _item text, _s uuid, _s_label text, _s_type text, _pred text,
  _o uuid, _o_label text, _o_type text, _basis text, _evidence text, _evidence_ok boolean)
RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  _tgt text := format('%s %s %s', _s_label, _pred, _o_label);
  _n   int;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');

  IF to_regclass('public.resource_links') IS NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'public.resource_links does not exist (block tools-04 has not run)');
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.resources r
                  WHERE r.id = _s AND r.resource_type::text = _s_type
                    AND pg_temp.kg_norm(r.name) = pg_temp.kg_norm(_s_label)) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('subject %s is gone, retyped or renamed (expected %s %L)', _s, _s_type, _s_label));
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.resources r
                  WHERE r.id = _o AND r.resource_type::text = _o_type
                    AND pg_temp.kg_norm(r.name) = pg_temp.kg_norm(_o_label)) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('object %s is gone, retyped or renamed (expected %s %L)', _o, _o_type, _o_label));
    RETURN;
  END IF;
  IF NOT coalesce(_evidence_ok, false) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'the evidence no longer holds in the live data: ' || _evidence);
    RETURN;
  END IF;
  -- An optional line uncommented with its <placeholder> still in place records nothing.
  IF _evidence ~ '<[^<>]+>' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'the evidence is still a placeholder: ' || _evidence || '; write where the link is stated, then run again');
    RETURN;
  END IF;

  INSERT INTO public.resource_links (subject_id, predicate, object_id, basis, evidence)
  VALUES (_s, _pred, _o, _basis, _evidence)
  ON CONFLICT (subject_id, predicate, object_id) DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _tgt, CASE WHEN _n > 0 THEN 'done' ELSE 'noop' END,
          CASE WHEN _n > 0 THEN _evidence ELSE 'link already recorded' END);
END
$fn$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. THE BLOCKS, in run order. Each is a pg_temp function; section 4 runs them. A block reports
--    every decision (done / noop / skipped / report / error) and never writes past a failed guard.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D00] Pre-flight (read-only): which ember-dandiset-sync is live
-- Pre-flight (report only). Hiding sticks only under the 16be24c ember-dandiset-sync: the old one
-- creates a resources row for every dandiset without one (`if (!resourceId)`), so at its next 04:17
-- UTC run it would recreate every node hidden here. The new sync's response lists a per-dandiset
-- "resource" key ('kept' / 'hidden' / 'created' / 'empty'); pg_net keeps recent responses for a few
-- hours, so a run shortly after 04:17 can tell which one is deployed.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d00() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE _new boolean; _old boolean;
BEGIN
  SELECT bool_or(r.content LIKE '%"resource":%'), bool_or(r.content NOT LIKE '%"resource":%')
    INTO _new, _old
    FROM (SELECT content FROM net._http_response
           WHERE content LIKE '%"linked_grants"%' ORDER BY created DESC LIMIT 1) r;
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES ('pre-flight: which ember sync is live', 'net._http_response', 'report',
          CASE WHEN _new THEN 'the latest ember-dandiset-sync response has per-dandiset "resource": the 16be24c sync is live, hides will stick'
               WHEN _old THEN 'the latest ember-dandiset-sync response has NO "resource" key: the OLD sync is live and will recreate the hidden datasets at 04:17 UTC; deploy 16be24c''s ember-dandiset-sync, then re-run D02-D05 if any came back'
               ELSE 'no ember-dandiset-sync response retained; cannot tell which sync is deployed (check after the next 04:17 UTC run: SELECT dandiset_id FROM public.dandisets WHERE hidden AND resource_id IS NOT NULL)' END);
EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES ('pre-flight: which ember sync is live', 'net._http_response', 'report',
          'net._http_response not readable here (' || SQLSTATE || '); check after the next 04:17 UTC run: SELECT dandiset_id FROM public.dandisets WHERE hidden AND resource_id IS NOT NULL');
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-01] Delete the 14 orphan investigator spine rows
-- Each is a resources row of type investigator that no investigators row points at: left behind
-- when a merge deleted only the investigators row (20260521172144, onboard_member MERGE
-- 20260810130000/20260811120000, 20260826120000 Tim Roberts), or when seed-consortium inserted
-- the spine row and then failed the investigators insert (seed-consortium/index.ts:2058-2075).
-- The real person is the linked twin named on each line. Deleted only if, at run time, the row is
-- still an orphan, still named as exported, still has no part_of_org, nothing references it, and
-- the twin still carries the real investigators row. Otherwise: skipped, with the reason.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_people_01() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  r     record;
  _refs text;
  _inv  text;
  _ke   int;
  _fp   bigint;
  _cal  bigint;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  FOR r IN
    SELECT * FROM (VALUES
      ('164c219c-6bc5-4975-8815-2c2e0dd2f8a1'::uuid, 'Bijan  Pesaran',        '4626de5c-667e-4f70-be3e-44dffde3887b'::uuid, 'Bijan Pesaran'),
      ('0401c6a9-2be9-47e3-981a-72481bd46a08'::uuid, 'Cristina  Savin',       '831a48e1-025d-499a-bf11-83d05285ed4b'::uuid, 'Cristina Savin'),
      ('4d4ad015-92f8-485e-9d4c-61dd5c18ac29'::uuid, 'Dayu  Lin',             'c140b518-3ea9-4cad-a8b2-c7b30385589b'::uuid, 'Dayu Lin'),
      ('83d790af-315f-4f1f-8efc-3718fc0581d3'::uuid, 'Flavia  Vitale',        '961fb77d-16c1-4efd-9fc7-ac7bd552c983'::uuid, 'Flavia Vitale'),
      ('99e94e46-f0af-4d3d-8ffd-ff522c4761db'::uuid, 'Melissa  Kline Struhl', '0f3bb33c-e7ee-4013-af5d-894d1adfa0ee'::uuid, 'Melissa Kline Struhl'),
      ('081d2ddb-e2c8-4909-84c4-740582fd757c'::uuid, 'Sima  Mofakham',        'bcdcd220-fa82-47d4-9c1b-7a8da03dadd8'::uuid, 'Sima Mofakham'),
      ('b50fe39f-f6d9-4362-a846-42ff705c73ac'::uuid, 'Sima Mofakham',         'bcdcd220-fa82-47d4-9c1b-7a8da03dadd8'::uuid, 'Sima Mofakham'),
      ('335d4d23-a7b3-496d-a721-db2f6a68ce07'::uuid, 'Tim Roberts',           '32937527-a5e9-4a99-84c0-719435f25f8b'::uuid, 'Timothy P Roberts'),
      ('b369e3dc-bb40-4cd7-ad5a-a329aa9278b8'::uuid, 'Chuck Mikell',          'c6056429-1e03-4506-8484-5be9acff8170'::uuid, 'Charles Mikell'),
      ('3cae416f-5424-49c3-b7c4-aedb7c53303f'::uuid, 'Charles B Mikell',      'c6056429-1e03-4506-8484-5be9acff8170'::uuid, 'Charles Mikell'),
      ('69f09b42-78f2-40f7-83d4-774738a4c974'::uuid, 'AVNIEL S GHUMAN',       'dc09061c-41ce-4e6e-bfe9-5e4805b4356c'::uuid, 'Avniel Ghuman'),
      ('4722e0eb-8daf-4685-8da4-fd7bb284d377'::uuid, 'Satrajit Ghosh',        'e5bdf58e-a1ff-4f5f-aa6d-667de414e16e'::uuid, 'Satrajit Sujit Ghosh'),
      ('307a2853-901d-4ce8-9894-a999868db705'::uuid, 'Yvonne Bennett',        '7ef0ea15-6f36-4bca-8eee-626e9bf76254'::uuid, 'Yvonne M Bennett'),
      ('63711ed4-4044-4b43-94c3-fee4d86d7b13'::uuid, 'Jeff Walker',           '7a5a1c11-f5f8-4643-b444-71228b1f298a'::uuid, 'Jeffery Walker')
    ) AS v(rid, label, twin, twin_label)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = r.rid) THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('orphan spine row', r.label || ' ' || r.rid, 'noop', 'already deleted');
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.resources x
                    WHERE x.id = r.rid AND x.resource_type = 'investigator'
                      AND pg_temp.kg_norm(x.name) = pg_temp.kg_norm(r.label)) THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('orphan spine row', r.label || ' ' || r.rid, 'skipped',
              'no longer an investigator spine row named ' || quote_literal(r.label));
      CONTINUE;
    END IF;
    -- Still an orphan? The export cannot tell an orphan from a person whose exported columns are all
    -- empty, so this is the check that decides.
    SELECT format('%s (%s)', i.id, i.name) INTO _inv
      FROM public.investigators i WHERE i.resource_id = r.rid LIMIT 1;
    IF _inv IS NOT NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('orphan spine row', r.label || ' ' || r.rid, 'skipped',
              'NOT an orphan: investigators row ' || _inv || ' points at it. Merge it into the twin '
              || r.twin_label || ' (' || r.twin || ') the 20260826120000 way instead of deleting.');
      CONTINUE;
    END IF;
    IF (SELECT organization_id FROM public.resources WHERE id = r.rid) IS NOT NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('orphan spine row', r.label || ' ' || r.rid, 'skipped',
              'resources.organization_id is set (a part_of_org edge), so the node is not isolated');
      CONTINUE;
    END IF;
    -- Principle III: delete the duplicate node only while the real person record is still there.
    IF NOT EXISTS (SELECT 1 FROM public.investigators i WHERE i.resource_id = r.twin) THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('orphan spine row', r.label || ' ' || r.rid, 'skipped',
              format('the twin %s (%s) no longer carries an investigators row; this spine row may be the person''s only node', r.twin_label, r.twin));
      CONTINUE;
    END IF;
    -- Nothing may reference it except the chat search index, which embed-knowledge only upserts.
    _refs := pg_temp.kg_fk_refs('public.resources'::regclass, r.rid, ARRAY['public.knowledge_embeddings.resource_id']);
    IF _refs <> '' THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('orphan spine row', r.label || ' ' || r.rid, 'skipped', 'still referenced: ' || _refs);
      CONTINUE;
    END IF;
    BEGIN
      DELETE FROM public.knowledge_embeddings WHERE resource_id = r.rid OR source_id::text = r.rid::text;
      GET DIAGNOSTICS _ke = ROW_COUNT;
      DELETE FROM public.resources WHERE id = r.rid;
      -- Logs and claims are history (field_provenance is append-only by trigger): reported, kept.
      SELECT count(*) INTO _fp  FROM public.field_provenance   WHERE entity_table = 'resources' AND entity_id = r.rid;
      SELECT count(*) INTO _cal FROM public.curation_audit_log WHERE resource_id = r.rid OR entity_id = r.rid;
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('orphan spine row', r.label || ' ' || r.rid, 'done',
              format('deleted; the person stays as %s (%s); %s search-index row(s) removed; %s provenance claim(s) and %s curation-log row(s) kept as history',
                     r.twin_label, r.twin, _ke, _fp, _cal));
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('orphan spine row', r.label || ' ' || r.rid, 'error', SQLSTATE || ': ' || SQLERRM);
    END;
  END LOOP;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-02] Delete the 'TestUser Tier2' test record
-- A test account's person record, with no facts and no links. Skipped, with the reason, if it is
-- linked to a login (deleting it would lock that login out: globus-auth admits only people who have
-- an investigators row), holds a grant roster row, or anything else references it. The precedent is
-- #517 block 12 (the 'Jane Doe' test record, deleted 2026-11-03 with the same three checks).
CREATE OR REPLACE FUNCTION pg_temp.kg_b_people_02() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  _rid   constant uuid := '1fb20b4f-fd8c-4e40-a4f4-daaa12bd738a';
  _item  constant text := 'test record TestUser Tier2';
  _inv   public.investigators%ROWTYPE;
  _n     int;
  _refs  text;
  _login text;
  _note  text := '';
  _ke    int := 0;
  _io    int := 0;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = _rid) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _rid::text, 'noop', 'already deleted');
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = _rid AND resource_type = 'investigator'
                    AND pg_temp.kg_norm(name) = 'testuser tier2') THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _rid::text, 'skipped', 'spine row renamed or retyped');
    RETURN;
  END IF;
  SELECT count(*) INTO _n FROM public.investigators WHERE resource_id = _rid;
  IF _n > 1 THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _rid::text, 'skipped', _n || ' investigators rows point at this spine row');
    RETURN;
  END IF;
  SELECT * INTO _inv FROM public.investigators WHERE resource_id = _rid;
  IF _inv.id IS NOT NULL THEN
    IF pg_temp.kg_norm(_inv.name) <> 'testuser tier2' THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _rid::text, 'skipped', format('its investigators row is named %L', _inv.name));
      RETURN;
    END IF;
    SELECT count(*) INTO _n FROM public.grant_investigators WHERE investigator_id = _inv.id;
    IF _n > 0 THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _rid::text, 'skipped', format('holds %s grant roster row(s); check before deleting', _n));
      RETURN;
    END IF;
    IF _inv.user_id IS NOT NULL THEN
      SELECT format('login %s <%s>, last sign-in %s, KG roles {%s}, profile row %s', u.id, u.email,
                    coalesce(u.last_sign_in_at::date::text, 'never'),
                    coalesce((SELECT string_agg(ur.role::text, ',' ORDER BY ur.role::text) FROM public.user_roles ur WHERE ur.user_id = u.id), ''),
                    CASE WHEN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id) THEN 'yes' ELSE 'no' END)
        INTO _login FROM auth.users u WHERE u.id = _inv.user_id;
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _rid::text, 'skipped',
              'linked to ' || coalesce(_login, 'auth user ' || _inv.user_id) ||
              '. Deleting the person row would lock that login out of sign-in. Remove the login in Authentication > Users (its user_roles go with it), then re-run.');
      RETURN;
    END IF;
    IF nullif(btrim(_inv.email), '') IS NOT NULL
       AND EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(btrim(_inv.email))) THEN
      _note := _note || ' An unlinked login with the same email exists; it can no longer pass the membership gate.';
    END IF;
    IF coalesce(cardinality(_inv.working_groups), 0) > 0 OR nullif(btrim(_inv.role), '') IS NOT NULL THEN
      _note := _note || format(' It listed role %L and working groups %s; Google Group memberships are not changed by a delete (run Group Audit).',
                               _inv.role, coalesce(_inv.working_groups::text, '{}'));
    END IF;
    _refs := pg_temp.kg_fk_refs('public.investigators'::regclass, _inv.id,
               ARRAY['public.investigator_organizations.investigator_id']);
    IF _refs <> '' THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _rid::text, 'skipped', 'person row referenced: ' || _refs);
      RETURN;
    END IF;
  END IF;
  _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _rid,
             ARRAY['public.knowledge_embeddings.resource_id', 'public.investigators.resource_id']);
  IF _refs <> '' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _rid::text, 'skipped', 'spine row referenced: ' || _refs);
    RETURN;
  END IF;
  BEGIN
    DELETE FROM public.knowledge_embeddings
     WHERE resource_id = _rid OR source_id::text IN (_rid::text, coalesce(_inv.id::text, '-'));
    GET DIAGNOSTICS _ke = ROW_COUNT;
    IF _inv.id IS NOT NULL THEN
      DELETE FROM public.investigator_organizations WHERE investigator_id = _inv.id;
      GET DIAGNOSTICS _io = ROW_COUNT;
      DELETE FROM public.investigators WHERE id = _inv.id;
    END IF;
    DELETE FROM public.resources WHERE id = _rid;
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _rid::text, 'done',
            format('deleted investigators row %s and the spine row; %s org link(s) and %s search-index row(s) removed.%s',
                   coalesce(_inv.id::text, '(none: it was an orphan)'), _io, _ke, _note));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _rid::text, 'error', SQLSTATE || ': ' || SQLERRM);
  END;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-03] Merge 'Niegil Francis Muttath Joseph' (83e96042) into 'Niegil Francis' (af80d437)
-- One person, two records. 20260811130000:7-8: niegil.francis@nyu.edu and nm4075@nyu.edu are ONE
-- Google identity (member id 114753211097378846591, stored email nm4075@nyu.edu), and :79/:84-85 say
-- the second record is "a duplicate to merge, not an alias". The keeper is the linked record
-- (af80d437: nm4075@nyu.edu per seed-consortium/index.ts:245-246, NYU member, WG-Analytics). The
-- duplicate (83e96042, the name on mit-workshop-seating.ts:83) has no facts and no links.
-- Follows 20260826120000: refuse rather than corrupt, repoint everything that references the
-- duplicate, re-anchor its provenance claims, delete it BEFORE writing its address onto the keeper
-- (investigators_email_unique_ci), then delete its spine row. Skipped, with the reason, if the
-- duplicate holds a roster row, a login, a role or working groups the keeper lacks, or any address
-- outside nyu.edu. No role or working_groups change, so trg_sync_member_groups does not fire.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_people_03() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  _keep_res constant uuid := 'af80d437-679c-42d0-aeed-fc7129b8a7b7';
  _drop_res constant uuid := '83e96042-a116-4e27-ab65-787db78d29f2';
  _item     constant text := 'merge Niegil Francis Muttath Joseph -> Niegil Francis';
  _keep public.investigators%ROWTYPE;
  _drop public.investigators%ROWTYPE;
  _n int; _refs text; _addr text[]; _bad text;
  _prov_guard boolean := false;
  _io int := 0; _cal int := 0; _ec int := 0; _fp int := 0; _ke int := 0;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = _drop_res) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'noop', 'duplicate spine row already gone');
    RETURN;
  END IF;

  -- Keeper: by spine id, still the NYU record the seed and backfills keyed on nm4075@nyu.edu.
  SELECT * INTO _keep FROM public.investigators WHERE resource_id = _keep_res;
  IF _keep.id IS NULL OR pg_temp.kg_norm(_keep.name) NOT IN ('niegil francis', 'niegil francis muttath joseph') THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _keep_res::text, 'skipped', 'keeper row not found on its spine row, or renamed');
    RETURN;
  END IF;
  IF lower(btrim(coalesce(_keep.email, ''))) <> 'nm4075@nyu.edu' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _keep_res::text, 'skipped', format('keeper primary email is %L, not the stored Google address nm4075@nyu.edu; identity not proven', _keep.email));
    RETURN;
  END IF;

  -- Duplicate: exactly one row on its spine row, still the name-only record.
  SELECT count(*) INTO _n FROM public.investigators WHERE resource_id = _drop_res;
  IF _n <> 1 THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'skipped', _n || ' investigators rows on the duplicate spine row (expected 1)');
    RETURN;
  END IF;
  SELECT * INTO _drop FROM public.investigators WHERE resource_id = _drop_res;
  IF pg_temp.kg_norm(_drop.name) <> 'niegil francis muttath joseph' OR _drop.id = _keep.id THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'skipped', format('duplicate row is named %L', _drop.name));
    RETURN;
  END IF;
  _addr := ARRAY(SELECT DISTINCT lower(btrim(e))
                   FROM unnest(array_append(coalesce(_drop.secondary_emails, '{}'::text[]), _drop.email)) AS e
                  WHERE nullif(btrim(e), '') IS NOT NULL);
  SELECT string_agg(e, ', ') INTO _bad FROM unnest(_addr) AS e WHERE e !~ '@nyu\.edu$';
  IF _bad IS NOT NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'skipped', 'duplicate holds address(es) outside nyu.edu (' || _bad || '); not provably the same NYU identity');
    RETURN;
  END IF;
  SELECT count(*) INTO _n FROM public.grant_investigators WHERE investigator_id = _drop.id;
  IF _n > 0 THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'skipped', _n || ' grant roster row(s) on the duplicate; re-decide which record survives');
    RETURN;
  END IF;
  IF _drop.user_id IS NOT NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _drop_res::text, 'skipped', format('the duplicate is the row linked to login %s%s; moving a login between records is a separate decision',
            _drop.user_id, CASE WHEN _keep.user_id IS NOT NULL THEN ' and the keeper is linked to ' || _keep.user_id ELSE '' END));
    RETURN;
  END IF;
  IF nullif(btrim(_drop.role), '') IS NOT NULL AND _drop.role IS DISTINCT FROM _keep.role THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'skipped', format('duplicate carries role %L; carrying it would fire trg_sync_member_groups', _drop.role));
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(_drop.working_groups, '{}'::text[])) AS w
              WHERE NOT (w = ANY (coalesce(_keep.working_groups, '{}'::text[])))) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'skipped', format('duplicate lists working groups %s the keeper lacks; carrying them would fire trg_sync_member_groups', _drop.working_groups));
    RETURN;
  END IF;
  _refs := pg_temp.kg_fk_refs('public.investigators'::regclass, _drop.id,
             ARRAY['public.investigator_organizations.investigator_id']);
  IF _refs <> '' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'skipped', 'duplicate person row referenced: ' || _refs);
    RETURN;
  END IF;
  _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _drop_res,
             ARRAY['public.knowledge_embeddings.resource_id', 'public.investigators.resource_id',
                   'public.entity_comments.resource_id']);
  IF _refs <> '' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'skipped', 'duplicate spine row referenced: ' || _refs);
    RETURN;
  END IF;

  BEGIN
    -- 1. Repoint. (investigator_id, organization_id) is the key, so drop links the keeper already has.
    DELETE FROM public.investigator_organizations d
     WHERE d.investigator_id = _drop.id
       AND EXISTS (SELECT 1 FROM public.investigator_organizations k
                    WHERE k.investigator_id = _keep.id AND k.organization_id = d.organization_id);
    UPDATE public.investigator_organizations SET investigator_id = _keep.id WHERE investigator_id = _drop.id;
    GET DIAGNOSTICS _io = ROW_COUNT;
    UPDATE public.curation_audit_log SET investigator_id = _keep.id WHERE investigator_id = _drop.id;
    GET DIAGNOSTICS _cal = ROW_COUNT;
    UPDATE public.curation_audit_log SET resource_id = _keep_res WHERE resource_id = _drop_res;
    UPDATE public.entity_comments SET resource_id = _keep_res WHERE resource_id = _drop_res;
    GET DIAGNOSTICS _ec = ROW_COUNT;

    -- 2. Provenance follows the person (20260826120000 step 2): only entity_id changes, with the
    --    append-only guard off for exactly this UPDATE. DDL is transactional, so if anything below
    --    fails the DISABLE is rolled back with it and the guard cannot be left off.
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgrelid = 'public.field_provenance'::regclass
                  AND tgname = 'trg_field_provenance_append_only' AND NOT tgisinternal AND tgenabled <> 'D') THEN
      ALTER TABLE public.field_provenance DISABLE TRIGGER trg_field_provenance_append_only;
      _prov_guard := true;
    END IF;
    UPDATE public.field_provenance SET entity_id = _keep.id
     WHERE entity_table = 'investigators' AND entity_id = _drop.id;
    GET DIAGNOSTICS _fp = ROW_COUNT;
    IF _prov_guard THEN
      ALTER TABLE public.field_provenance ENABLE TRIGGER trg_field_provenance_append_only;
    END IF;

    -- 3. The chat index keeps its own copy of the duplicate (embed-knowledge only upserts).
    DELETE FROM public.knowledge_embeddings
     WHERE resource_id = _drop_res OR source_id::text IN (_drop.id::text, _drop_res::text);
    GET DIAGNOSTICS _ke = ROW_COUNT;

    -- 4. Delete the duplicate, THEN record its addresses on the keeper (the unique email index
    --    forbids the address on two rows), plus the alias Google reported (20260811130000:7-8).
    DELETE FROM public.investigators WHERE id = _drop.id;
    UPDATE public.investigators
       SET secondary_emails = ARRAY(
             SELECT DISTINCT lower(btrim(e))
               FROM unnest(coalesce(secondary_emails, '{}'::text[]) || _addr || ARRAY['niegil.francis@nyu.edu']) AS e
              WHERE nullif(btrim(e), '') IS NOT NULL
                AND lower(btrim(e)) <> lower(btrim(coalesce(email, '')))),
           updated_at = now()
     WHERE id = _keep.id;

    -- 5. The duplicate's spine row, once nothing references it.
    _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _drop_res, '{}'::text[]);
    IF _refs <> '' THEN
      RAISE EXCEPTION 'duplicate spine row still referenced after the repoint: %', _refs;
    END IF;
    DELETE FROM public.resources WHERE id = _drop_res;

    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _drop_res::text || ' -> ' || _keep_res::text, 'done',
            format('merged: duplicate %s deleted with its spine row; keeper %s secondary_emails now %s; repointed %s org link(s), %s curation-log row(s), %s comment(s); %s provenance claim(s) re-anchored; %s search-index row(s) removed',
                   _drop.id, _keep.id,
                   (SELECT coalesce(secondary_emails::text, '{}') FROM public.investigators WHERE id = _keep.id),
                   _io, _cal, _ec, _fp, _ke));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'error', SQLSTATE || ': ' || SQLERRM);
  END;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [tools-01] Fold the duplicate Lightning Pose spine row 444f664a into 3ba48c59
-- Two resources rows are named Lightning Pose. 3ba48c59 is the one software_tools points at (docs_url,
-- repo_url, language, license); 444f664a holds only a name, a shorter copy of the same description
-- (the keeper's text up to "Zuckerman Institute") and an external_url equal to 3ba48c59's docs_url. Both are isolated nodes. 444f664a is the older
-- row (in every export since 956f028, 2026-09-21; 3ba48c59 first appears in 5882e1a, 2026-09-23), so
-- it may carry Resources-page display fields in metadata (category, algorithm, ...) that the keeper
-- lacks: those are copied over first, keeper winning every conflict. Then the house merge pattern
-- (20260826120000: repoint, don't lose; 20261106130000: drop the search-index copy, delete the spine
-- row only if no foreign key still points at it). All writes run in one sub-block: if anything
-- fails, the sub-block rolls back on its own and is reported, and the rest of the script goes on.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_tools_01() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  _keep constant uuid := '3ba48c59-bb79-44ef-8569-ca644775d73a';
  _dup  constant uuid := '444f664a-b7ee-4571-ad81-33bd93b03cca';
  _item constant text := 'lightning pose duplicate';
  _tgt  constant text := 'Lightning Pose 444f664a -> 3ba48c59';
  _skipkeys constant text[] := ARRAY['source_id', 'source_table', 'field_provenance'];
  _k public.resources%ROWTYPE;
  _d public.resources%ROWTYPE;
  _docs text; _repo text; _refs text;
  _copied text; _kept text;
  _moved int := 0; _cal int := 0; _ke int := 0; _fp int := 0;
  _norm_url text;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');

  SELECT * INTO _d FROM public.resources WHERE id = _dup;
  IF NOT FOUND THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _tgt, 'noop', 'duplicate already gone');
    RETURN;
  END IF;
  SELECT * INTO _k FROM public.resources WHERE id = _keep;
  IF NOT FOUND OR _k.resource_type::text <> 'software' OR pg_temp.kg_norm(_k.name) <> 'lightning pose' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'the record to keep (3ba48c59) is gone, retyped or renamed; not deleting what may now be the only copy');
    RETURN;
  END IF;
  IF _d.resource_type::text <> 'software' OR pg_temp.kg_norm(_d.name) <> 'lightning pose' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('444f664a is now %s %L; a curator decides', _d.resource_type, _d.name));
    RETURN;
  END IF;
  SELECT st.docs_url, st.repo_url INTO _docs, _repo
    FROM public.software_tools st WHERE st.resource_id = _keep ORDER BY st.created_at LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'no software_tools row points at 3ba48c59 any more; which row is the duplicate is no longer clear');
    RETURN;
  END IF;

  -- Still the same tool, decided from the two rows: the duplicate's link is one of the keeper's
  -- links (at export: its external_url = the keeper's docs_url), or its description, less the final
  -- period, is the start of the keeper's (at export: 264 of its 265 characters).
  _norm_url := lower(rtrim(btrim(coalesce(_d.external_url, '')), '/'));
  IF NOT ((_norm_url <> '' AND _norm_url IN (lower(rtrim(btrim(coalesce(_docs, '')), '/')),
                                              lower(rtrim(btrim(coalesce(_repo, '')), '/')),
                                              lower(rtrim(btrim(coalesce(_k.external_url, '')), '/'))))
          OR (rtrim(btrim(coalesce(_d.description, '')), '.') <> ''
              AND position(rtrim(btrim(_d.description), '.') IN coalesce(_k.description, '')) = 1)) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('the rows no longer look like one tool (duplicate url %L, keeper docs %L repo %L)', _d.external_url, _docs, _repo));
    RETURN;
  END IF;
  IF _d.organization_id IS NOT NULL AND _k.organization_id IS NOT NULL AND _d.organization_id <> _k.organization_id THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'the two rows name different organizations; a curator decides');
    RETURN;
  END IF;
  -- Look before writing: anything else that points at the duplicate stops the merge. Comments and the
  -- search index are handled below, so they are not counted here.
  _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _dup,
                              ARRAY['public.entity_comments.resource_id', 'public.knowledge_embeddings.resource_id']);
  IF _refs <> '' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'still referenced: ' || _refs);
    RETURN;
  END IF;

  BEGIN
    -- 1. Fill-only-empty metadata and organization onto the keeper. The duplicate's identity keys stay behind.
    SELECT string_agg(e.key, ', ' ORDER BY e.key) FILTER (WHERE NOT (coalesce(_k.metadata, '{}'::jsonb) ? e.key)),
           string_agg(e.key, ', ' ORDER BY e.key) FILTER (WHERE (coalesce(_k.metadata, '{}'::jsonb) ? e.key)
                                                            AND (_k.metadata -> e.key) IS DISTINCT FROM e.value)
      INTO _copied, _kept
      FROM jsonb_each(CASE WHEN jsonb_typeof(_d.metadata) = 'object' THEN _d.metadata ELSE '{}'::jsonb END) AS e
     WHERE e.key <> ALL (_skipkeys);
    IF _copied IS NOT NULL OR (_k.organization_id IS NULL AND _d.organization_id IS NOT NULL) THEN
      UPDATE public.resources k
         SET metadata = (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                           FROM jsonb_each(CASE WHEN jsonb_typeof(_d.metadata) = 'object' THEN _d.metadata ELSE '{}'::jsonb END) AS e
                          WHERE e.key <> ALL (_skipkeys))
                        || CASE WHEN jsonb_typeof(k.metadata) = 'object' THEN k.metadata ELSE '{}'::jsonb END,
             organization_id = coalesce(k.organization_id, _d.organization_id)
       WHERE k.id = _keep;
    END IF;

    -- 2. Comments on the duplicate follow the tool (threads keep their parent_id).
    UPDATE public.entity_comments SET resource_id = _keep WHERE resource_id = _dup;
    GET DIAGNOSTICS _moved = ROW_COUNT;
    -- 3. Curation-log scoping follows the survivor (20261106130000:46, 20260826120000:172). No FK.
    UPDATE public.curation_audit_log SET resource_id = _keep WHERE resource_id = _dup;
    GET DIAGNOSTICS _cal = ROW_COUNT;
    -- 4. The chat index's own copy of the duplicate (embed-knowledge only ever upserts).
    DELETE FROM public.knowledge_embeddings WHERE resource_id = _dup OR source_id = _dup::text;
    GET DIAGNOSTICS _ke = ROW_COUNT;
    -- 5. field_provenance claims about the duplicate's cells stay: append-only history of a deleted
    --    row, as for the spine row 20261106130000 deleted. data_audit_log records the DELETE below.
    SELECT count(*) INTO _fp FROM public.field_provenance WHERE entity_table = 'resources' AND entity_id = _dup;

    -- 6. Delete, only if nothing points at it now.
    _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _dup);
    IF _refs <> '' THEN
      RAISE EXCEPTION 'still referenced after the repoint: %', _refs;
    END IF;
    DELETE FROM public.resources WHERE id = _dup;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'error', 'rolled back, nothing changed: ' || SQLERRM);
    RETURN;
  END;

  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _tgt, 'done',
          format('deleted 444f664a; metadata keys copied to 3ba48c59: %s; keeper''s value kept for: %s; comments moved: %s; curation_audit_log rows repointed: %s; search-index rows deleted: %s; field_provenance rows left as history: %s',
                 coalesce(_copied, 'none'), coalesce(_kept, 'none'), _moved, _cal, _ke, _fp));
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [notices-03] Merge the superseded forecast RFA-NS-26-011 into RFA-NS-27-002
-- The forecast's own title ends '[forecast — superseded by RFA-NS-27-002]', it is closed, and it
-- points at the same simpler.grants.gov opportunity as RFA-NS-27-002. fon is the upsert key
-- (20260903140000:16-18, bbqs-mcp add_funding_opportunity on_conflict=fon), so posting under the new
-- number made a second row instead of updating this one. It is the only call with no
-- participating_orgs, so #512 will never link it, and CQ17 lists it as still open.
-- RFA-NS-27-002 has no description and no purpose (the export shows none; roundtrip: purpose is
-- set on 12 of 14 rows, every one carried), so the forecast holds the programme's only text: it is
-- copied first, and the old FON is kept in the keeper's notes. Then the forecast's search-index
-- entries, its detail row (funding_opportunity_orgs rows cascade) and its spine row go, the
-- 20261106130000 way: delete the spine row only if no foreign key still points at it.
-- The deleted rows stay recoverable: data_audit_log keeps each one in full (old_data).
CREATE OR REPLACE FUNCTION pg_temp.kg_b_notices_03() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  _old_rid constant uuid := 'e0042c46-59de-40f6-b53d-8e565cc27a45';
  _new_rid constant uuid := '9fe36a51-d470-42f8-baa1-0c7aa68a9dea';
  _old_fon constant text := 'RFA-NS-26-011';
  _new_fon constant text := 'RFA-NS-27-002';
  _item    constant text := 'merge superseded forecast';
  _tgt     constant text := 'RFA-NS-26-011 -> RFA-NS-27-002';
  _old     public.funding_opportunities%ROWTYPE;
  _new     public.funding_opportunities%ROWTYPE;
  _old_res public.resources%ROWTYPE;
  _new_res public.resources%ROWTYPE;
  _has_old boolean;
  _refs    text;
  _note    text;
  _done    text[] := '{}';
  _n       int;
  _ke      int;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');

  SELECT * INTO _old_res FROM public.resources WHERE id = _old_rid;
  IF NOT FOUND THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'noop', 'forecast spine row already gone (merged earlier)');
    RETURN;
  END IF;
  IF _old_res.resource_type::text <> 'funding' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('spine row %s is typed %s, not funding; not touched', _old_rid, _old_res.resource_type));
    RETURN;
  END IF;

  -- The keeper must exist, both rows, before anything is copied or deleted.
  SELECT * INTO _new_res FROM public.resources WHERE id = _new_rid AND resource_type::text = 'funding';
  IF NOT FOUND THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('keeper spine row %s is missing; nothing deleted', _new_rid));
    RETURN;
  END IF;
  SELECT * INTO _new FROM public.funding_opportunities WHERE resource_id = _new_rid AND fon = _new_fon;
  IF NOT FOUND THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'keeper detail row (fon RFA-NS-27-002 on spine 9fe36a51-...) is missing; nothing deleted');
    RETURN;
  END IF;

  SELECT count(*) INTO _n FROM public.funding_opportunities WHERE resource_id = _old_rid;
  IF _n > 1 THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('%s funding_opportunities rows point at the forecast spine row; a curator decides', _n));
    RETURN;
  END IF;
  SELECT * INTO _old FROM public.funding_opportunities WHERE resource_id = _old_rid;
  _has_old := FOUND;

  -- Same programme, by the records themselves.
  IF _has_old THEN
    IF _old.fon IS DISTINCT FROM _old_fon THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _tgt, 'skipped', format('the forecast spine row''s detail row has fon %L, not %s; not touched', _old.fon, _old_fon));
      RETURN;
    END IF;
    IF _old.title !~* 'superseded by RFA-NS-27-002' OR _old.url IS DISTINCT FROM _new.url THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _tgt, 'skipped',
              format('no longer reads as superseded by the keeper (title %L; url %s vs %s); not touched', _old.title, _old.url, _new.url));
      RETURN;
    END IF;
    IF _old.status = 'open' THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, _tgt, 'skipped', 'the forecast has been set open again; a curator decides');
      RETURN;
    END IF;
  ELSIF _old_res.name !~* 'superseded by RFA-NS-27-002' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', format('spine row has no detail row and its name %L does not say it is superseded; not touched', _old_res.name));
    RETURN;
  END IF;

  -- Anything else that still points at the forecast stops the merge. Its own detail row and its
  -- search-index entries are removed below; a comment (entity_comments) is never deleted to make room.
  _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _old_rid,
             ARRAY['public.funding_opportunities.resource_id', 'public.knowledge_embeddings.resource_id']);
  IF _has_old THEN
    _refs := btrim(_refs || ' ' || pg_temp.kg_fk_refs('public.funding_opportunities'::regclass, _old.id,
                                                      ARRAY['public.funding_opportunity_orgs.funding_opportunity_id']));
  END IF;
  IF _refs <> '' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _tgt, 'skipped', 'the forecast is still referenced (' || _refs || '); nothing changed');
    RETURN;
  END IF;

  -- 1. Carry over what the keeper lacks: the programme description and purpose, the old FON, and
  --    any funder link (none expected: the forecast has no participating_orgs).
  IF nullif(btrim(_new_res.description), '') IS NULL
     AND nullif(btrim(coalesce(nullif(btrim(_old_res.description), ''), _old.purpose)), '') IS NOT NULL THEN
    UPDATE public.resources
       SET description = coalesce(nullif(btrim(_old_res.description), ''), _old.purpose), updated_at = now()
     WHERE id = _new_rid;
    _done := _done || 'resources.description'::text;
  END IF;
  IF _has_old AND nullif(btrim(_new.purpose), '') IS NULL AND nullif(btrim(_old.purpose), '') IS NOT NULL THEN
    UPDATE public.funding_opportunities SET purpose = _old.purpose, updated_at = now() WHERE id = _new.id;
    _done := _done || 'purpose'::text;
  END IF;
  IF strpos(coalesce(_new.notes, ''), _old_fon) = 0 THEN
    _note := format('Forecast: %s (posted %s), merged into this record 2026-11-16.',
                    _old_fon, coalesce(_old.posted_date::text, 'date unknown'))
             || CASE WHEN nullif(btrim(_old.notes), '') IS NOT NULL THEN ' Forecast notes: ' || btrim(_old.notes) ELSE '' END;
    UPDATE public.funding_opportunities
       SET notes = CASE WHEN nullif(btrim(notes), '') IS NULL THEN _note ELSE notes || E'\n' || _note END,
           updated_at = now()
     WHERE id = _new.id;
    _done := _done || 'notes (old FON)'::text;
  END IF;
  IF _has_old AND to_regclass('public.funding_opportunity_orgs') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.funding_opportunity_orgs (funding_opportunity_id, organization_id)
             SELECT $1, organization_id FROM public.funding_opportunity_orgs WHERE funding_opportunity_id = $2
             ON CONFLICT DO NOTHING' USING _new.id, _old.id;
    GET DIAGNOSTICS _n = ROW_COUNT;
    IF _n > 0 THEN _done := _done || format('%s funder link(s)', _n); END IF;
  END IF;

  -- 2. The chat search index keeps its own copy (embed-knowledge only upserts, and keys a resources
  --    row by its id): remove the forecast's entries before the spine row, which one may reference.
  DELETE FROM public.knowledge_embeddings
   WHERE resource_id = _old_rid OR source_id = _old_rid::text OR source_id = _old.id::text;
  GET DIAGNOSTICS _ke = ROW_COUNT;

  -- 3. The detail row (its funding_opportunity_orgs rows cascade), then the spine row, re-checked.
  IF _has_old THEN
    DELETE FROM public.funding_opportunities WHERE id = _old.id;
  END IF;
  _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _old_rid);
  IF _refs <> '' THEN
    RAISE EXCEPTION 'forecast spine row still referenced (%)', _refs;
  END IF;
  DELETE FROM public.resources WHERE id = _old_rid;

  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _tgt, 'done',
          format('copied onto RFA-NS-27-002: %s; removed %s search-index row(s), the funding_opportunities row and spine row %s',
                 CASE WHEN cardinality(_done) = 0 THEN 'nothing (the keeper already had it)' ELSE array_to_string(_done, ', ') END,
                 _ke, _old_rid));
EXCEPTION WHEN OTHERS THEN
  -- Nothing of this block is kept: it rolls back to its own savepoint.
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _tgt, 'error', SQLSTATE || ': ' || SQLERRM || ' (nothing changed)');
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D01] Apply 20261105120000 (dandisets.hidden*, CHECK, set_dandiset_hidden) where missing
-- Its live status is unknown. The columns and the CHECK are exactly the migration's
-- (20261105120000:7-15). The ALTER runs only if a column is missing (ALTER TABLE takes an ACCESS
-- EXCLUSIVE lock on dandisets even when every column is there), so a re-run touches nothing. The
-- function is created only when it is absent, so a live (possibly newer) version is never
-- overwritten; it is created verbatim so curators can unhide through the MCP tool later. Without this
-- block the D02-D05 hides cannot run, and ember-dandiset-sync (16be24c) cannot honour them.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d01() RETURNS void LANGUAGE plpgsql AS
$blk$
DECLARE
  _missing text;
BEGIN
  SELECT string_agg(c, ', ' ORDER BY c) INTO _missing
    FROM unnest(ARRAY['hidden', 'hidden_reason', 'hidden_by', 'hidden_at']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = 'public.dandisets'::regclass AND a.attname = c
                        AND a.attnum > 0 AND NOT a.attisdropped);
  IF _missing IS NOT NULL THEN
    ALTER TABLE public.dandisets
      ADD COLUMN IF NOT EXISTS hidden        boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS hidden_reason text,
      ADD COLUMN IF NOT EXISTS hidden_by     uuid,
      ADD COLUMN IF NOT EXISTS hidden_at     timestamptz;
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES ('dandiset_hidden DDL', 'dandisets.hidden*', 'done', 'column(s) added (20261105120000:7-11): ' || _missing);
  ELSE
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES ('dandiset_hidden DDL', 'dandisets.hidden*', 'noop', 'columns already present');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.dandisets'::regclass AND conname = 'dandisets_hidden_has_reason') THEN
    ALTER TABLE public.dandisets
      ADD CONSTRAINT dandisets_hidden_has_reason CHECK (NOT hidden OR hidden_reason IS NOT NULL);
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES ('dandiset_hidden DDL', 'dandisets_hidden_has_reason', 'done', 'CHECK added (20261105120000:13-15)');
  ELSE
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES ('dandiset_hidden DDL', 'dandisets_hidden_has_reason', 'noop', 'CHECK already present');
  END IF;

  IF to_regprocedure('public.set_dandiset_hidden(text[],boolean,text,text)') IS NULL THEN
    -- Verbatim from 20261105120000:19-80.
    CREATE FUNCTION public.set_dandiset_hidden(
      _dandiset_ids text[], _hidden boolean DEFAULT true, _reason text DEFAULT NULL, _instance text DEFAULT 'ember')
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
    DECLARE
      _d       public.dandisets;
      _rid     uuid;
      _missing text[];
      _out     jsonb := '[]'::jsonb;
    BEGIN
      IF auth.uid() IS NULL OR NOT public.is_curator_or_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins or curators can hide or unhide dandisets';
      END IF;
      IF coalesce(cardinality(_dandiset_ids), 0) = 0 THEN
        RAISE EXCEPTION 'No dandiset ids given';
      END IF;
      IF _hidden AND nullif(btrim(_reason), '') IS NULL THEN
        RAISE EXCEPTION 'A reason is required to hide a dandiset';
      END IF;

      SELECT array_agg(x ORDER BY x) INTO _missing FROM unnest(_dandiset_ids) x
       WHERE NOT EXISTS (SELECT 1 FROM public.dandisets d WHERE d.instance = _instance AND d.dandiset_id = x);
      IF _missing IS NOT NULL THEN
        RAISE EXCEPTION 'Not in the % mirror: %', _instance, array_to_string(_missing, ', ');
      END IF;

      FOR _d IN SELECT * FROM public.dandisets
                 WHERE instance = _instance AND dandiset_id = ANY (_dandiset_ids)
                 ORDER BY dandiset_id FOR UPDATE LOOP
        IF _hidden THEN
          UPDATE public.dandisets
             SET hidden = true, hidden_reason = btrim(_reason), hidden_by = auth.uid(), hidden_at = now(),
                 resource_id = NULL
           WHERE id = _d.id;
          IF _d.resource_id IS NOT NULL THEN
            DELETE FROM public.resources WHERE id = _d.resource_id;
          END IF;
          _out := _out || jsonb_build_object('dandiset_id', _d.dandiset_id, 'name', _d.name,
                                             'hidden', true, 'resource_removed', _d.resource_id IS NOT NULL);
        ELSE
          _rid := _d.resource_id;
          IF _rid IS NULL THEN
            -- Same row ember-dandiset-sync would have created.
            INSERT INTO public.resources (name, description, resource_type, external_url, metadata)
            VALUES (_d.name, left(coalesce(_d.description, ''), 4000), 'dataset',
                    coalesce(_d.draft_url, 'https://dandi.emberarchive.org/dandiset/' || _d.dandiset_id),
                    jsonb_build_object('source', _d.instance, 'dandiset_id', _d.dandiset_id))
            RETURNING id INTO _rid;
          END IF;
          UPDATE public.dandisets
             SET hidden = false, hidden_reason = NULL, hidden_by = NULL, hidden_at = NULL, resource_id = _rid
           WHERE id = _d.id;
          _out := _out || jsonb_build_object('dandiset_id', _d.dandiset_id, 'name', _d.name,
                                             'hidden', false, 'resource_id', _rid);
        END IF;
      END LOOP;

      RETURN jsonb_build_object('ok', true, 'count', jsonb_array_length(_out), 'dandisets', _out);
    END;
    $fn$;
    REVOKE ALL ON FUNCTION public.set_dandiset_hidden(text[], boolean, text, text) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.set_dandiset_hidden(text[], boolean, text, text) TO authenticated;
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES ('dandiset_hidden DDL', 'set_dandiset_hidden()', 'done', 'created from 20261105120000:19-80');
  ELSE
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES ('dandiset_hidden DDL', 'set_dandiset_hidden()', 'noop', 'already present; left as is');
  END IF;
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D02] Hide the 28 IDP/ARC integration-test uploads (#506)
-- 26 copies of one IDP four-choice digging-task upload (000550-000551, 000559-000563,
-- 000610-000628; R34DA062119's ARC/IDP platform testing its EMBER upload from a developer machine),
-- plus 'arc-idp-test' (000533) and 'aggregate-task-one' (000542). The real dataset, 000607, stays
-- (D07 links it). Each call re-checks the mirror row and skips, with a report row, if the upload
-- was renamed, got linked, or its spine row is referenced by anything but the mirror and the
-- search index.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d02() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000550', 'eef427e0-8f77-423f-9c21-db3e1eef5b74', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- IDP-ARC — Four-choice reversal digging task
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000551', '82dd5aa5-3e9e-4f8b-ab99-9da5f557580a', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- IDP-ARC — Four-choice reversal digging task
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000559', 'fc39570e-25ee-4d25-8606-1da0f0a03d43', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000560', '67eda9ac-ecbc-494f-b34f-671f074344d0', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000561', '95740d4f-1e7f-474d-96ac-cbb99161a800', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000562', '9be4379c-b96a-4a12-b128-b91bf85554ab', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000563', '9923fbb5-0ea9-48d8-8ad9-386af3233e00', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000610', '556563f6-a276-4de9-ac21-57ab8a53acf0', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000611', '404ca8b2-c293-40f2-be94-f3ae24b30af1', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000612', '00b12533-f062-4b07-956e-62cdd5145e49', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000613', '013d5512-b094-4603-8eb5-5a4ed578501d', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000614', '71f322a4-f40f-4dc8-b8d6-2a05c4692c0c', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000615', '9bb42f0a-2bf6-4f88-b621-e2d65d31fa71', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000616', '9d48505e-4e39-425a-ac10-2f1d28ebcbc1', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000617', '29d65027-e638-43f7-b860-9bde457d4830', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000618', 'b1246cb8-0963-4160-bb14-8f313a885dcc', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000619', 'c104aeb5-4e17-4b00-b120-1f8343435b78', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000620', '344938eb-1ef4-4b39-b6e2-a8297f510dbd', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000621', 'e25c35c9-96b7-4410-bd9f-cfc0382fded2', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000622', '9a538af9-78f2-49ab-ac2f-24f6d66f3936', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000623', 'fae4c50f-849c-4ec8-91d6-15da5747305e', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000624', '51314407-e284-4b97-b708-6d4ac938320b', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000625', '7758db83-7d6a-46d9-9cbb-dd78d0e2853a', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000626', 'f85d4385-1c70-4282-a6f2-0bd7f3c91df9', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000627', '5866f05c-c82e-4c6b-9e7a-829799ee866d', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000628', '33aad87e-eca4-4de4-b67c-425bd39ec168', '(idp.*four-choice reversal digging task|four-choice reversal digging task.*\(idp\))', 'IDP/ARC integration test upload (#506)');  -- Four-choice reversal digging task (IDP)
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000533', 'e5d71308-2123-4732-952c-e3e1bfb32108', '^\s*arc-idp-test\s*$', 'IDP/ARC integration test upload (#506)');  -- arc-idp-test
  PERFORM pg_temp.kg_ds_hide('hide IDP/ARC test upload', '000542', 'f9d3a756-c9ad-4abb-89ae-c55756d4e662', '^\s*aggregate-task-one\s*$', 'IDP/ARC integration test upload (#506)');  -- aggregate-task-one
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D03] Hide the four test uploads 000001, 000003, 000431, 000467 (#506)
-- 'test', 'Test DANDIset (Brock test)', 'TestNeuroConvUpload', 'Test dataset for Pennsieve upload'.
-- #506 also lists 000472 (D05 decides it from file_count) and 000598 (linked; datasets-O1, optional).
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d03() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  PERFORM pg_temp.kg_ds_hide('hide test upload', '000001', '0c87346c-ae43-4e45-8708-682c41353bcc', '^\s*test\s*$', 'test or placeholder upload (#506)');  -- test
  PERFORM pg_temp.kg_ds_hide('hide test upload', '000003', '38f4034a-316a-4439-a0d7-161992a8aa67', 'test', 'test or placeholder upload (#506)');  -- Test DANDIset (Brock test)
  PERFORM pg_temp.kg_ds_hide('hide test upload', '000431', '2b9b6595-65f5-4f03-b4d4-d6725b6bb1c0', 'test\s*neuro\s*conv', 'test or placeholder upload (#506)');  -- TestNeuroConvUpload
  PERFORM pg_temp.kg_ds_hide('hide test upload', '000467', '821b1f4e-5bdf-45be-8319-d10a2620fb1a', 'test dataset', 'test or placeholder upload (#506)');  -- Test dataset for Pennsieve upload
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D04] Hide 'Single Click Science' (000468): synthetic mock data, #444 Exclude
-- Its own description: "a synthetic dataset for cell morphology containing mock data". #506's list
-- leaves it out; #444's dataset review marks it Exclude. Reversible: set_dandiset_hidden(false).
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d04() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  PERFORM pg_temp.kg_ds_hide('hide synthetic mock data', '000468', '00a0773c-3d61-4450-8256-ab7456c87953', 'single click science', 'synthetic mock data, not BBQS data (#444 Exclude)');  -- Single Click Science
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D05] 'Pozu: Missing subjects' (000472): hide if it has 0 files, else link it to R24MH136632
-- Contested. #506 lists it as a placeholder; its own description ("Dedicated collection of reports
-- of video frames missing any subject") and #444 put it with the Pozu collections. The live mirror
-- decides: file_count = 0 -> hide (as #506 asks); file_count > 0 -> link to R24MH136632 under the
-- same evidence rule as the rest of the Pozu group (D06); NULL (never counted) -> skip and report.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d05() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE _fc integer; _found boolean;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  SELECT d.file_count, true INTO _fc, _found
    FROM public.dandisets d WHERE d.instance = 'ember' AND d.dandiset_id = '000472';
  IF NOT coalesce(_found, false) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES ('000472 by file_count', '000472', 'skipped', 'not in the ember mirror');
  ELSIF _fc = 0 THEN
    PERFORM pg_temp.kg_ds_hide('000472 empty -> hide', '000472', '241a21ae-2f3c-4fce-b11d-d42980ed7209',
      'missing subjects', 'empty placeholder: 0 files on EMBER-DANDI (#506)');
  ELSIF _fc > 0 THEN
    PERFORM pg_temp.kg_ds_link('000472 has files -> EMBER', '000472', '241a21ae-2f3c-4fce-b11d-d42980ed7209',
      'missing subjects', 'R24MH136632', 'roster',
      'Pozu collection on EMBER-DANDI with ' || _fc || ' file(s); #444 lists it with the EMBER (R24MH136632) collections.');
  ELSE
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES ('000472 by file_count', '000472 Pozu: Missing subjects', 'skipped',
            'file_count is NULL (never counted); run ember-dandiset-sync, then re-run this block');
  END IF;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D09] Merge species 'Acoel Flatworm' (10ceb449) into Hofstenia miamia (d6fbdcc7)
-- Seeded as species 'Acoel Worm' / common name 'Acoel Flatworm' (spine row 10ceb449-..., species row
-- 88f275de-... in the 2026-09-21 export) from the label seed-all-tables gives R34DA061984. After
-- 20260819120000 put R34DA061984's real species (Hofstenia miamia, "We will study the acoel worm,
-- Hofstenia miamia") on the project, migration:add_hofstenia_species added a second row
-- (d6fbdcc7-...) instead of renaming this one, so the old row is an isolated duplicate.
-- 1. aliases 'acoel worm' / 'acoel flatworm' -> Hofstenia miamia (kind taxon_assumed: a clade-level
--    name read as R34DA061984's acoel is a judgement, 20260820190000:46-47), so the old names still
--    resolve; 2. carry the duplicate's metadata onto the keeper (keys it lacks; arrays unioned, e.g.
--    {"grants": ["R34DA061984"]}, the one species.metadata cell roundtrip.json saw);
-- 3. delete the duplicate's species row, its search-index copy and its spine row, only if no foreign
--    key still points at the spine row (the 20261106130000 step 3 scan). Atomic: any error rolls the
--    whole merge back and leaves a report row.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d09() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  _dup_rid  constant uuid := '10ceb449-38ab-4e52-9422-39722583f074';  -- KG node 'Acoel Flatworm'
  _keep_rid constant uuid := 'd6fbdcc7-30d7-48ba-9c46-b70e227c59cf';  -- KG node 'Hofstenia miamia'
  _item     constant text := 'merge Acoel Flatworm into Hofstenia miamia';
  _k        public.species%ROWTYPE;
  _a        public.species%ROWTYPE;
  _has_a    boolean := false;
  _rname    text;
  _rtype    text;
  _refs     text;
  _n        int;
  _meta     jsonb;
  _key      text;
  _val      jsonb;
  _carried  text := '';
  _claims   text;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');

  -- The keeper: Hofstenia miamia on its spine row.
  SELECT * INTO _k FROM public.species WHERE resource_id = _keep_rid;
  IF NOT FOUND OR lower(btrim(_k.name)) <> 'hofstenia miamia' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _keep_rid::text, 'skipped', 'keeper species row (Hofstenia miamia on d6fbdcc7) not found as expected');
    RETURN;
  END IF;

  -- The duplicate: its spine row must still be the acoel species row.
  SELECT r.name, r.resource_type::text INTO _rname, _rtype FROM public.resources r WHERE r.id = _dup_rid;
  IF NOT FOUND THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _dup_rid::text, 'noop', 'spine row already gone (merged earlier)');
    RETURN;
  END IF;
  IF _rtype <> 'species' OR _rname !~* 'acoel' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _dup_rid::text, 'skipped', format('spine row is now %L (%s), not the acoel species row', _rname, _rtype));
    RETURN;
  END IF;
  SELECT count(*) INTO _n FROM public.species WHERE resource_id = _dup_rid;
  IF _n > 1 THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _dup_rid::text, 'skipped', format('%s species rows share the spine row; a curator decides', _n));
    RETURN;
  END IF;
  SELECT * INTO _a FROM public.species WHERE resource_id = _dup_rid;
  _has_a := FOUND;
  IF _has_a AND NOT (coalesce(_a.name, '') ~* 'acoel' OR coalesce(_a.common_name, '') ~* 'acoel') THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _dup_rid::text, 'skipped', format('species row on the spine is %L / %L, not the acoel row', _a.name, _a.common_name));
    RETURN;
  END IF;

  -- Nothing but the duplicate's own species row and its search-index copy may point at the spine.
  _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _dup_rid,
             ARRAY['public.species.resource_id', 'public.knowledge_embeddings.resource_id']);
  IF _refs <> '' THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _dup_rid::text, 'skipped', format('spine row still referenced (%s); not merging', _refs));
    RETURN;
  END IF;

  -- Who still names the old row? These resolve to Hofstenia through the aliases below, so they do
  -- not block the merge; they are reported so a curator can tidy the raw values.
  SELECT string_agg(DISTINCT p.grant_number || ':' || s, ', ') INTO _claims
    FROM public.projects p, unnest(coalesce(p.study_species, '{}'::text[])) AS s
   WHERE lower(btrim(s)) IN ('acoel worm', 'acoel flatworm', 'acoel')
      OR lower(btrim(s)) = nullif(lower(btrim(coalesce(_a.name, ''))), '')
      OR lower(btrim(s)) = nullif(lower(btrim(coalesce(_a.common_name, ''))), '');
  IF _claims IS NOT NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, 'projects.study_species', 'report', 'still name the old row (now resolve via alias): ' || _claims);
  END IF;

  -- 1. Aliases. Never overwrite an existing mapping; report one that points elsewhere.
  INSERT INTO public.species_aliases (alias, canonical, kind, common_name, note) VALUES
    ('acoel worm',     'Hofstenia miamia', 'taxon_assumed', 'panther worm',
     'R34DA061984''s acoel worm: "We will study the acoel worm, Hofstenia miamia". Merged duplicate species row Acoel Worm / Acoel Flatworm (10ceb449) on 2026-11-16.'),
    ('acoel flatworm', 'Hofstenia miamia', 'taxon_assumed', 'panther worm',
     'R34DA061984''s acoel worm: "We will study the acoel worm, Hofstenia miamia". Merged duplicate species row Acoel Worm / Acoel Flatworm (10ceb449) on 2026-11-16.')
  ON CONFLICT (alias) DO NOTHING;
  SELECT string_agg(alias || ' -> ' || coalesce(canonical, '(none)'), ', ') INTO _claims
    FROM public.species_aliases
   WHERE alias IN ('acoel worm', 'acoel flatworm') AND canonical IS DISTINCT FROM 'Hofstenia miamia';
  IF _claims IS NOT NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, 'species_aliases', 'report', 'existing alias kept, maps elsewhere: ' || _claims);
  END IF;

  -- 2. Carry the duplicate's metadata: keys the keeper lacks are added, arrays are unioned (e.g.
  --    grants), and a differing scalar stays as the keeper has it (reported).
  IF _has_a THEN
    _meta := coalesce(_k.metadata, '{}'::jsonb);
    IF jsonb_typeof(_a.metadata) = 'object' THEN
      FOR _key, _val IN SELECT * FROM jsonb_each(_a.metadata) LOOP
        IF NOT (_meta ? _key) THEN
          _meta := _meta || jsonb_build_object(_key, _val);
          _carried := _carried || format('metadata.%s added; ', _key);
        ELSIF jsonb_typeof(_meta -> _key) = 'array' AND jsonb_typeof(_val) = 'array' THEN
          IF NOT ((_meta -> _key) @> _val) THEN
            _meta := jsonb_set(_meta, ARRAY[_key],
                       (SELECT jsonb_agg(DISTINCT e) FROM (SELECT jsonb_array_elements(_meta -> _key) AS e
                                                           UNION SELECT jsonb_array_elements(_val)) u));
            _carried := _carried || format('metadata.%s unioned; ', _key);
          END IF;
        ELSIF (_meta -> _key) IS DISTINCT FROM _val THEN
          _carried := _carried || format('metadata.%s differs, keeper''s kept (%s); ', _key, _val);
        END IF;
      END LOOP;
    END IF;
    IF _meta IS DISTINCT FROM coalesce(_k.metadata, '{}'::jsonb) THEN
      UPDATE public.species SET metadata = _meta WHERE id = _k.id;
    END IF;
    -- Taxonomy levels are reported, not copied: a generic "acoel worm" row's family or genus need
    -- not be Hofstenia's, and these columns are not exported (only common_name and taxonomy_class).
    IF (_k.taxonomy_order IS NULL AND _a.taxonomy_order IS NOT NULL)
       OR (_k.taxonomy_family IS NULL AND _a.taxonomy_family IS NOT NULL)
       OR (_k.taxonomy_genus IS NULL AND _a.taxonomy_genus IS NOT NULL) THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, 'species.taxonomy_*', 'report',
              format('the duplicate had order %s / family %s / genus %s where Hofstenia miamia has none; not copied, a curator may fill them',
                     coalesce(_a.taxonomy_order, '-'), coalesce(_a.taxonomy_family, '-'), coalesce(_a.taxonomy_genus, '-')));
    END IF;

    -- 3a. The duplicate species row (audited by trg_audit_species). No foreign key points at species.
    DELETE FROM public.species WHERE id = _a.id;
  END IF;

  -- 3b. Its chat-index copies, then its spine row (audited by trg_audit_resources).
  DELETE FROM public.knowledge_embeddings
   WHERE resource_id = _dup_rid OR source_id IN (_dup_rid::text, coalesce(_a.id::text, ''));
  DELETE FROM public.resources WHERE id = _dup_rid;

  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, 'Acoel Flatworm (10ceb449) -> Hofstenia miamia (d6fbdcc7)', 'done',
          format('aliases acoel worm / acoel flatworm -> Hofstenia miamia; %sspecies row %s and spine row deleted',
                 CASE WHEN _carried = '' THEN 'nothing to carry; ' ELSE _carried END,
                 coalesce(_a.id::text, '(none: orphan spine row)')));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _dup_rid::text, 'error', SQLSTATE || ': ' || SQLERRM);
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-06] Create 'University College London' and 'University of Washington' (only if people-08 can link someone)
-- No organization node exists for either. The shape is #512's 20261103130000 DO block (also #517
-- block 5): a resources row of type organization whose metadata points back at the organizations
-- row, and organizations.resource_id set, because the exporter only nodes an organization that
-- has a spine row (kg/bbqs_kg.py:127-131). Names are the curated canonical names of
-- 20260807160000:46,49,101; RePORTER imports match organizations with ilike (nih-grants:319,
-- add-project-by-grant:264), so a later 'UNIVERSITY OF WASHINGTON' import reuses this row.
-- An existing row of the same name is reused; one without a spine row is given one. Nothing is
-- created unless people-08 will be able to link someone to it: a new organization with no member would
-- itself be an isolated node.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_people_06() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  r      record;
  _elig  int;
  _oid   uuid;
  _rid   uuid;
  _hid   uuid;
  _hres  uuid;
  _hname text;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  FOR r IN
    SELECT * FROM (VALUES
      ('University College London', '(\mucl\M|university college london)',
       ARRAY['1ee83670-fadd-4744-91bd-17ca61944822']::uuid[]),                                        -- Andrew MacAskill
      ('University of Washington',  '(university of washington|\muw\M)',
       ARRAY['85a49b85-44ff-4f85-a110-c3860bfe6747', 'cbb1fcfa-0a1d-432d-a4bb-a325516b6594']::uuid[])  -- Annette Estes, Tanya St. John
    ) AS v(org_name, expect, people)
  LOOP
    _hid := NULL; _hres := NULL; _hname := NULL;
    SELECT o.id, o.resource_id, o.name INTO _hid, _hres, _hname
      FROM public.organizations o
     WHERE pg_temp.kg_norm(o.name) = pg_temp.kg_norm(r.org_name)
     ORDER BY (o.resource_id IS NULL), o.created_at
     LIMIT 1;
    IF _hid IS NOT NULL AND _hres IS NOT NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('create organization', r.org_name, 'noop',
              format('exists: organizations %s (%L), spine %s', _hid, _hname, _hres));
      CONTINUE;
    END IF;
    -- Who people-08 could link: a person row on the exported spine row, unaffiliated, institution not contradicting.
    SELECT count(*) INTO _elig
      FROM public.investigators i
     WHERE i.resource_id = ANY (r.people)
       AND NOT EXISTS (SELECT 1 FROM public.investigator_organizations io WHERE io.investigator_id = i.id)
       AND (nullif(btrim(i.institution), '') IS NULL OR i.institution ~* r.expect);
    IF _elig = 0 THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('create organization', r.org_name, 'skipped',
              'nobody people-08 could link to it, so no spine row is made (a memberless organization would be a new isolated node)');
      CONTINUE;
    END IF;
    BEGIN
      IF _hid IS NULL THEN
        _oid := gen_random_uuid();
        INSERT INTO public.resources (resource_type, name, metadata)
        VALUES ('organization', r.org_name, jsonb_build_object('source_id', _oid, 'source_table', 'organizations'))
        RETURNING id INTO _rid;
        INSERT INTO public.organizations (id, name, resource_id) VALUES (_oid, r.org_name, _rid);
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES ('create organization', r.org_name, 'done',
                format('organizations %s with spine row %s; %s person(s) to link in people-08', _oid, _rid, _elig));
      ELSE  -- exists without a spine row (nih-grants / verify-affiliations insert a name only)
        INSERT INTO public.resources (resource_type, name, metadata)
        VALUES ('organization', _hname, jsonb_build_object('source_id', _hid, 'source_table', 'organizations'))
        RETURNING id INTO _rid;
        UPDATE public.organizations SET resource_id = _rid WHERE id = _hid;
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES ('create organization', r.org_name, 'done',
                format('existing organizations %s (%L) had no spine row; gave it %s', _hid, _hname, _rid));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES ('create organization', r.org_name, 'error', SQLSTATE || ': ' || SQLERRM);
    END;
  END LOOP;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-05] Affiliate the 11 NIH program staff with their institute (or NIH)
-- They hold no grant by design, so the link that fits is affiliation (an org `members` edge), the
-- way Christina Hatch, Christina Liu and Yuan Luo are already members of National Institutes of
-- Health. The specific institute where the repo names it, else NIH. Each target org is matched by
-- its spine id (= its KG node id) and exported name. A row whose own institution text names a
-- non-NIH place, or a different institute, is skipped for a curator.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_people_05() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  r record;
  -- Institute codes other than the target: an institution text naming one of them contradicts it.
  _ics constant text[] := ARRAY['nimh','nida','ninds','nidcd','nia','niaaa','nibib','nichd','nei','nccih',
                                'nhlbi','nigms','niehs','nidcr','niddk','niams','nimhd','ninr','nlm','nci',
                                'niaid','nhgri','ncats'];
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  FOR r IN
    SELECT * FROM (VALUES
      ('7745a449-07ce-4762-988e-e355a72b0775'::uuid, 'Arina Knowlton',     '28609b98-6f97-4a46-b875-9f5084f1c7cd'::uuid, 'National Institute of Mental Health', 'nimh',
       'institution NIH/NIMH at creation, 20260807170000:21'),
      ('9eb4af78-4485-4c7b-9179-76d079bde109'::uuid, 'Ashlee Van''t Veer', '208980e9-92b9-447e-a2ca-e83bf61db159'::uuid, 'National Institutes of Health', NULL,
       'consortium label NIH program staff, #517 block 12; no institute in the repo'),
      ('79c7ff27-6bd7-4b92-b22c-9f4f80a507ab'::uuid, 'Crystal Lantz',      '208980e9-92b9-447e-a2ca-e83bf61db159'::uuid, 'National Institutes of Health', NULL,
       'NIH BRAIN Initiative, NIH Program, mit-workshop-seating.ts:32'),
      ('2f334517-3173-4654-987e-dc44e0e94eb2'::uuid, 'Eunyoung Kim',       '28609b98-6f97-4a46-b875-9f5084f1c7cd'::uuid, 'National Institute of Mental Health', 'nimh',
       'NIH/NIMH/BRAIN Initiative, 20260807150000:162, seed-consortium/index.ts:407-411, seating:196'),
      ('36ba050d-e4f4-470c-a780-eddef3b4bab8'::uuid, 'Farah Bader',        '69aa906c-2a0c-4524-8958-4e1009f96060'::uuid, 'National Institute of Neurological Disorders and Stroke', 'ninds',
       'Farah Nikhath Bader, NINDS/BRAIN Initiative, seating:121; SfN 2025 symposium organizer, SFN2025.tsx:186'),
      ('5899fd56-4c11-41a1-8b0a-4e1785820391'::uuid, 'Joseph Monaco',      '208980e9-92b9-447e-a2ca-e83bf61db159'::uuid, 'National Institutes of Health', NULL,
       'NIH/BRAIN, 20260807150000:158, seed-consortium/index.ts:457-462; no institute named'),
      ('b723b975-9438-4c08-b9b9-404846e31272'::uuid, 'Karen David',        '69aa906c-2a0c-4524-8958-4e1009f96060'::uuid, 'National Institute of Neurological Disorders and Stroke', 'ninds',
       'Karen Kate David, NIH BRAIN/NINDS, seating:67; form answer NIH, 20260807150000:128'),
      ('3cc135af-1424-4cc9-b54b-978d039ad6d1'::uuid, 'Kari Johnson',       '208980e9-92b9-447e-a2ca-e83bf61db159'::uuid, 'National Institutes of Health', NULL,
       'NIH, 20260807150000:161, seed-consortium/index.ts:416-421, seating:197'),
      ('8b45a6d3-febb-4537-9786-69685e36aa6d'::uuid, 'Lizzy Ankudowich',   '28609b98-6f97-4a46-b875-9f5084f1c7cd'::uuid, 'National Institute of Mental Health', 'nimh',
       'NIMH, BBQS Co-Lead, 20260910120000:3, 20260831120000:3, seating:103'),
      ('4412f5e5-aba7-49fb-876c-618f59f9b226'::uuid, 'Merav Sabri',        'a6ed8610-4f99-43cb-b0fa-ed983bfa2f20'::uuid, 'National Institute on Deafness and Other Communication Disorders', 'nidcd',
       'NIH/NIDCD, NIH Program, seating:178'),
      ('24703152-c43b-4f4f-8d73-65f3ef490ff0'::uuid, 'Ming Zhan',          '32f761ce-6857-451c-9eb7-fc5b8b221449'::uuid, 'National Institute on Drug Abuse', 'nida',
       'NIDA/NIH, seating:139; created with a nih.gov address, 20260521171202:16-23')
    ) AS v(rid, label, org_rid, org_label, ic, evidence)
  LOOP
    PERFORM pg_temp.kg_link_org(
      'NIH program staff -> institute', r.rid, r.label, r.org_rid, r.org_label,
      '(nih|national institute|brain)',
      CASE WHEN r.ic IS NULL THEN NULL
           ELSE '\m(' || array_to_string(array_remove(_ics, r.ic), '|') || ')\M' END,
      r.evidence);
  END LOOP;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-07] Affiliate 16 members with the existing organization node their institution names
-- Each has no roster row, no organization link and no working group, so the node is isolated. The
-- institution is in the repo: the person's own onboarding-form answer (as seeded by seed-consortium
-- or backfilled by 20260807150000/160000/170000), the 2026-09-08 workshop seating plan, or the SfN
-- pages. The org is matched by its spine id (= KG node id) and exported name. kg_link_org skips any
-- row whose own institution text contradicts the evidence, or that already has an organization.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_people_07() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE r record;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  FOR r IN
    SELECT * FROM (VALUES
      ('ea2dc7bf-af90-460d-9823-45e9407b6bb8'::uuid, 'David Ostry',         'e5044d9f-fe07-4a69-a9c3-7aecc245b941'::uuid, 'YALE UNIVERSITY',
       'yale', 'form: Yale Child Study Center, 20260807150000:145, seed-consortium/index.ts:550; normalized Yale University, 20260807160000:91'),
      ('e631bc65-b164-4090-b442-3dacddd2707a'::uuid, 'Gaurav Patel',        '9f75488b-59d0-4d50-b7db-869f26066743'::uuid, 'COLUMBIA UNIVERSITY HEALTH SCIENCES',
       'columbia', 'form: Columbia University, 20260807150000:87, seed-consortium/index.ts:1675; cumc.columbia.edu address, normalized Columbia University Irving Medical Center, 20260807160000:33'),
      ('e055175b-7bfb-471e-8e80-d8697b484b9d'::uuid, 'Jongwoon Kim',        '6efc2552-7cd7-4e53-bd2d-41fee6824cf7'::uuid, 'NEW YORK UNIVERSITY SCHOOL OF MEDICINE',
       '(nyu|new york univ|langone|columbia)', 'form: NYU, Columbia University, 20260807150000:182, seed-consortium/index.ts:67-73; nyulangone.org address, normalized NYU Langone Health, 20260807160000:128'),
      ('37453416-6149-4fee-b9b9-a427b800ffe7'::uuid, 'Meaghan Perdue',      '4284d761-dde2-4e72-8cb4-d3724f2d4b32'::uuid, 'UNIV OF MASSACHUSETTS MED SCH WORCESTER',
       '(umass|massachusetts)', 'form: UMass Chan Medical School, 20260807150000:150, seed-consortium/index.ts:622, 20260807160000:96; seating:68'),
      ('639e73b5-6a6d-46f1-82a8-b466d7e3bdbb'::uuid, 'Olha Metenko',        '29d3cb38-1cbb-43b7-baa6-f413d0a0bdad'::uuid, 'UNIVERSITY OF PENNSYLVANIA',
       '(upenn|university of pennsylvania|penn medicine|duncan)', 'form: UPenn - Dr. Duncan, 20260807170000:33 (Dominique Duncan is a UPenn member)'),
      ('1cfe15ec-b6a7-4534-b69d-79bb63b341b6'::uuid, 'Weikang Shi',         'e5044d9f-fe07-4a69-a9c3-7aecc245b941'::uuid, 'YALE UNIVERSITY',
       'yale', 'form: Yale, 20260807150000:143, seed-consortium/index.ts:705; 20260807160000:89; seating:118; SFN2025.tsx:261'),
      ('0f65886e-44cb-4a8b-88a2-ecb214b0ea99'::uuid, 'Yangjia Li',          '9f75488b-59d0-4d50-b7db-869f26066743'::uuid, 'COLUMBIA UNIVERSITY HEALTH SCIENCES',
       'columbia', 'form: Columbia University, 20260807150000:86, seed-consortium/index.ts:1702, 20260807160000:32'),
      ('aa69dcd5-bd16-40ef-909e-3f2985d66c65'::uuid, 'Deepa Purushothaman', 'e5044d9f-fe07-4a69-a9c3-7aecc245b941'::uuid, 'YALE UNIVERSITY',
       'yale', 'Yale University, Postdoc/Grad, mit-workshop-seating.ts:175'),
      ('f9cc96dd-52b0-41bc-b687-47a1e4df3e2c'::uuid, 'Dorota Jarecka',      '7924e7d9-5b53-4525-95ef-3f5a6b9112a5'::uuid, 'MASSACHUSETTS INSTITUTE OF TECHNOLOGY',
       '(\mmit\M|massachusetts institute of technology)', 'MIT, Infra (EMBER), mit-workshop-seating.ts:140'),
      ('aa9445fe-736e-4a1e-b8a4-4b709c4a6603'::uuid, 'Luke Bloy',           'f28a2f16-5259-4e2f-9c8e-a5d11d2b5c5f'::uuid, 'CHILDREN''S HOSP OF PHILADELPHIA',
       '(chop|children.?s hosp)', 'CHOP, Research Staff, mit-workshop-seating.ts:51'),
      ('eff6d625-81ad-4a38-9f8e-93a2ae06c7af'::uuid, 'Nicole Tregoning',    '315a0694-ce8d-4010-abca-5438e5f6b560'::uuid, 'JOHNS HOPKINS UNIVERSITY',
       '(johns hopkins|\mjhu|\mapl\M|applied physics)', 'Johns Hopkins University, mit-workshop-seating.ts:174; JHU Applied Physics Laboratory with Brock Wester (a JHU member), SFN2025.tsx:319'),
      ('c520d01a-3746-4f7d-baff-ad1dab70e1b3'::uuid, 'Terry Jernigan',      'd2821755-977a-46a2-a089-169f6e66aeea'::uuid, 'UNIVERSITY OF CALIFORNIA, SAN DIEGO',
       '(ucsd|uc san diego|san diego)', 'UC San Diego, mit-workshop-seating.ts:160'),
      ('25a4f79c-6020-4074-b501-0114a205175f'::uuid, 'Thomas Heeps',        '622f970b-e529-441d-b5f3-739025a38aa9'::uuid, 'UNIVERSITY OF FLORIDA',
       '(florida|\mufl?\M)', 'University of Florida, Undergraduate, mit-workshop-seating.ts:189'),
      ('977712f0-0daf-4238-a693-42c96f0874a2'::uuid, 'Ugne Klibaite',       '99bc7f7b-2a3d-4e34-99f1-ec08e12133b2'::uuid, 'HARVARD UNIVERSITY',
       'harvard', 'Harvard University, mit-workshop-seating.ts:152'),
      ('70205506-97d5-4503-bc59-e9a25934e699'::uuid, 'Varun Thvar',         '7924e7d9-5b53-4525-95ef-3f5a6b9112a5'::uuid, 'MASSACHUSETTS INSTITUTE OF TECHNOLOGY',
       '(\mmit\M|massachusetts institute of technology)', 'MIT, Visiting Undergrad, mit-workshop-seating.ts:193'),
      ('87b79b22-888b-40ac-bee6-32a62f07645f'::uuid, 'Yunsoo Kim',          'c04b3bcd-d1db-4b3c-9dc6-a4c97039cad6'::uuid, 'STATE UNIVERSITY NEW YORK STONY BROOK',
       '(stony ?brook|\msbu\M|suny)', 'Stony Brook University Hospital, mit-workshop-seating.ts:190 (Sima Mofakham, same hospital at seating:99, is a member of this node)')
    ) AS v(rid, label, org_rid, org_label, expect, evidence)
  LOOP
    PERFORM pg_temp.kg_link_org('member -> organization', r.rid, r.label, r.org_rid, r.org_label, r.expect, NULL, r.evidence);
  END LOOP;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-08] Affiliate 3 members with the organizations people-06 creates
CREATE OR REPLACE FUNCTION pg_temp.kg_b_people_08() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE r record;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  FOR r IN
    SELECT * FROM (VALUES
      ('1ee83670-fadd-4744-91bd-17ca61944822'::uuid, 'Andrew MacAskill',    NULL::uuid, 'University College London',
       '(\mucl\M|university college london)', 'form: UCL, 20260807150000:155, seed-consortium/index.ts:490; ucl.ac.uk address, 20260807160000:101'),
      ('85a49b85-44ff-4f85-a110-c3860bfe6747'::uuid, 'Annette Estes',       NULL::uuid, 'University of Washington',
       '(university of washington|\muw\M)', 'form: University of Washington, 20260807150000:100, seed-consortium/index.ts:1369; uw.edu address, 20260807160000:46'),
      ('cbb1fcfa-0a1d-432d-a4bb-a325516b6594'::uuid, 'Tanya St. John',      NULL::uuid, 'University of Washington',
       '(university of washington|\muw\M)', 'form: University of Washington Autism Center, 20260807150000:103, seed-consortium/index.ts:1323; uw.edu address, 20260807160000:49')
    ) AS v(rid, label, org_rid, org_label, expect, evidence)
  LOOP
    PERFORM pg_temp.kg_link_org('member -> new organization', r.rid, r.label, r.org_rid, r.org_label, r.expect, NULL, r.evidence);
  END LOOP;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-10] Both Walker records side by side (read-only; the merge itself is optional)
-- people-10-merge input. Both Walker records side by side, for the curator's same-person decision.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_people_10_report() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  SELECT 'Walker records (curator: same person?)', coalesce(i.name, v.label) || ' ' || v.rid, 'report',
         CASE WHEN i.id IS NULL THEN 'no investigators row on this spine row'
              ELSE format('email domain=%s; institution=%s; role=%s; working_groups=%s; login=%s; roster=%s; created %s',
                          coalesce(nullif(split_part(coalesce(i.email, ''), '@', 2), ''), '(none)'),
                          coalesce(quote_literal(nullif(btrim(i.institution), '')), '(empty)'),
                          coalesce(quote_literal(nullif(btrim(i.role), '')), '(empty)'),
                          coalesce(i.working_groups::text, '{}'),
                          CASE WHEN i.user_id IS NULL THEN 'no' ELSE 'yes' END,
                          coalesce((SELECT string_agg(g.grant_number || ':' || gi.role, ', ')
                                      FROM public.grant_investigators gi JOIN public.grants g ON g.id = gi.grant_id
                                     WHERE gi.investigator_id = i.id), 'none'),
                          i.created_at::date)
         END
    FROM (VALUES
      ('7a5a1c11-f5f8-4643-b444-71228b1f298a'::uuid, 'Jeffery Walker'),
      ('e1424ffb-1cc6-4d9a-932e-464c967a68f9'::uuid, 'Jeffrey Walker')
    ) AS v(rid, label)
    LEFT JOIN public.investigators i ON i.resource_id = v.rid;
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [notices-01] Copy announcements' (and jobs') organization onto their spine rows
-- The exporter writes part_of_org only from resources.organization_id (kg/bbqs_kg.py:154-155) and
-- reads neither announcements nor jobs. On 11-03 all 12 announcements and all 6 jobs got their
-- organization on the detail row, but only the 6 jobs and the 6 NIH/NSF announcements were copied
-- onto their spine rows (#517, origin/dev 20261103170000:92-125; its block-8 comment says the other
-- 6 were never synced). This copies the other 6 (5 -> BBQS Consortium, 'SFN Annual Meeting 2025' ->
-- Society for Neuroscience), which also de-isolates those two organization nodes. Jobs are included
-- so the two columns cannot stay apart; expect 0 job rows today.
-- Only an EMPTY spine column is filled. A spine row that already names a different organization is
-- reported for a curator (with the UPDATE that would take the detail value), never overwritten.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_notices_01() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  r     record;
  _n    int;
  _now  uuid;
  _item constant text := 'sync spine organization';
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  FOR r IN
    SELECT 'announcement'::text AS kind, a.resource_id, a.organization_id AS org_id,
           s.resource_type::text AS rtype, s.name AS spine_name, s.organization_id AS spine_org,
           o.name AS org_name, o.resource_id AS org_rid, so.name AS spine_org_name
      FROM public.announcements a
      JOIN public.resources s      ON s.id = a.resource_id
      JOIN public.organizations o  ON o.id = a.organization_id
      LEFT JOIN public.organizations so ON so.id = s.organization_id
     WHERE s.organization_id IS DISTINCT FROM a.organization_id
    UNION ALL
    SELECT 'job', j.resource_id, j.organization_id,
           s.resource_type::text, s.name, s.organization_id,
           o.name, o.resource_id, so.name
      FROM public.jobs j
      JOIN public.resources s      ON s.id = j.resource_id
      JOIN public.organizations o  ON o.id = j.organization_id
      LEFT JOIN public.organizations so ON so.id = s.organization_id
     WHERE s.organization_id IS DISTINCT FROM j.organization_id
     ORDER BY 1, 5
  LOOP
    BEGIN
      IF r.rtype <> r.kind THEN
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES (_item, r.spine_name, 'skipped',
                format('spine row %s is typed %s, not %s; not touched', r.resource_id, r.rtype, r.kind));
      ELSIF r.spine_org IS NOT NULL THEN
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES (_item, r.spine_name, 'skipped',
                format('spine row already names %s, the %s row names %s; a curator decides. To take the %s value: '
                       'UPDATE public.resources SET organization_id = %L, updated_at = now() WHERE id = %L;',
                       r.spine_org_name, r.kind, r.org_name, r.kind, r.org_id, r.resource_id));
      ELSE
        UPDATE public.resources SET organization_id = r.org_id, updated_at = now()
         WHERE id = r.resource_id AND organization_id IS NULL;
        GET DIAGNOSTICS _n = ROW_COUNT;
        IF _n = 1 THEN
          INSERT INTO kg_fix_report (item, target, outcome, detail)
          VALUES (_item, r.spine_name, 'done',
                  format('%s spine row -> %s%s', r.kind, r.org_name,
                         CASE WHEN r.org_rid IS NULL
                              THEN ' (that organization has no spine row, so the export still writes no edge)'
                              ELSE '' END));
        ELSE   -- another detail row pointing at the same spine row got there first
          SELECT organization_id INTO _now FROM public.resources WHERE id = r.resource_id;
          INSERT INTO kg_fix_report (item, target, outcome, detail)
          VALUES (_item, r.spine_name, CASE WHEN _now = r.org_id THEN 'noop' ELSE 'skipped' END,
                  CASE WHEN _now = r.org_id THEN 'already set'
                       ELSE format('two detail rows share spine row %s and name different organizations; a curator decides', r.resource_id) END);
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, r.spine_name, 'error', SQLSTATE || ': ' || SQLERRM);
    END;
  END LOOP;

  -- The 6 nodes this block is for (export UUIDs, and the organization #517 block 7 recorded on 11-03).
  -- Report only what is not as expected afterwards: still unlinked (and why), or linked elsewhere.
  FOR r IN
    SELECT v.*, s.id AS sid, s.organization_id AS sorg, o.resource_id AS sorg_rid, o.name AS sorg_name,
           (SELECT count(*) FROM public.announcements a WHERE a.resource_id = v.rid) AS n_ann,
           (SELECT count(*) FROM public.announcements a WHERE a.resource_id = v.rid AND a.organization_id IS NOT NULL) AS n_ann_org
      FROM (VALUES
        ('46841d0e-4d55-4690-81f0-41c33f424bc8'::uuid, 'Canada Impact+ Research Training Awards (CIRTA)',                         '766331fd-daea-4a31-86c4-589737e533ea'::uuid, 'BBQS Consortium'),
        ('00343fc4-d3b9-4b22-8445-dcef0a11a5e4'::uuid, 'Children''s Speech Recognition Challenge — $120K Prize Pool',              '766331fd-daea-4a31-86c4-589737e533ea'::uuid, 'BBQS Consortium'),
        ('5b87def1-786b-470f-879c-9089ebde049d'::uuid, 'Consortia-Wide Workshop at MIT',                                          '766331fd-daea-4a31-86c4-589737e533ea'::uuid, 'BBQS Consortium'),
        ('1b79d65a-57fd-455c-96e7-acc3b3eb6c01'::uuid, 'In the news: AI is helping scientists eavesdrop on Costa Rica''s monkeys', '766331fd-daea-4a31-86c4-589737e533ea'::uuid, 'BBQS Consortium'),
        ('42efe7fa-561b-4a00-af58-78b71f9d4b1a'::uuid, 'New BBQS Website Launch',                                                 '766331fd-daea-4a31-86c4-589737e533ea'::uuid, 'BBQS Consortium'),
        ('3533afc4-be44-460c-bada-ab578b028acb'::uuid, 'SFN Annual Meeting 2025',                                                 '00b6e913-54e0-4cb5-bfdb-7c4123de51d6'::uuid, 'Society for Neuroscience')
      ) AS v(rid, label, org_rid, org_label)
      LEFT JOIN public.resources s     ON s.id = v.rid
      LEFT JOIN public.organizations o ON o.id = s.organization_id
  LOOP
    IF r.sid IS NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, r.label, 'report', format('spine row %s no longer exists', r.rid));
    ELSIF r.sorg IS NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, r.label, 'skipped',
              CASE WHEN r.n_ann = 0 THEN 'no announcements row has resource_id = this node; nothing to copy'
                   WHEN r.n_ann_org = 0 THEN format('its announcements row has organization_id NULL: the 11-03 link (#517 block 7: %s) is missing live; not guessed here', r.org_label)
                   ELSE 'still unlinked; see the rows above' END);
    ELSIF r.sorg_rid IS NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, r.label, 'skipped',
              format('linked to %s, which has no spine row, so the export writes no edge', r.sorg_name));
    ELSIF r.sorg_rid IS DISTINCT FROM r.org_rid THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, r.label, 'report',
              format('linked to %s, not the %s #517 block 7 recorded (still de-isolated)', r.sorg_name, r.org_label));
    END IF;
  END LOOP;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [notices-02] Event 'BBQS MIT Workshop 2026' -> BBQS Consortium
-- The only Event is a hand-made spine row (name + description, no events table), so its only
-- possible link today is resources.organization_id, which the exporter writes as part_of_org
-- (kg/bbqs_kg.py:154-155). Its own description reads 'Annual BBQS consortium workshop, MIT,
-- Cambridge MA', and the site calls it the '2nd Annual ... Workshop at MIT' held for 'BBQS
-- consortium members and affiliates' (src/pages/MITWorkshop2026.tsx:102, :180, :223): the
-- consortium is the organizer, MIT the venue (the schema keeps that in Event.venue). Set only
-- where the column is empty.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_notices_02() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  _rid   constant uuid := 'eac8b2aa-4353-4d9a-af21-601294a8ef4a';
  _label constant text := 'BBQS MIT Workshop 2026';
  _item  constant text := 'event organization';
  _type  text;
  _name  text;
  _cur   uuid;
  _org   uuid;
  _n     int;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  SELECT resource_type::text, name, organization_id INTO _type, _name, _cur
    FROM public.resources WHERE id = _rid;
  IF NOT FOUND THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _label, 'skipped', format('spine row %s no longer exists', _rid));
    RETURN;
  END IF;
  IF _type <> 'event' OR pg_temp.kg_norm(_name) <> pg_temp.kg_norm(_label) THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _label, 'skipped', format('spine row %s is now %s %L; not touched', _rid, _type, _name));
    RETURN;
  END IF;
  _org := pg_temp.kg_org_of('766331fd-daea-4a31-86c4-589737e533ea', 'BBQS Consortium');
  IF _org IS NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _label, 'skipped', 'organization BBQS Consortium (spine 766331fd-...) not found with an organizations row on a spine row');
    RETURN;
  END IF;
  IF _cur IS NOT NULL THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, _label, CASE WHEN _cur = _org THEN 'noop' ELSE 'skipped' END,
            CASE WHEN _cur = _org THEN 'already BBQS Consortium'
                 ELSE format('already linked to %s; a curator chose it, left as is',
                             (SELECT name FROM public.organizations WHERE id = _cur)) END);
    RETURN;
  END IF;
  UPDATE public.resources SET organization_id = _org, updated_at = now()
   WHERE id = _rid AND organization_id IS NULL;
  GET DIAGNOSTICS _n = ROW_COUNT;
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _label, CASE WHEN _n = 1 THEN 'done' ELSE 'noop' END, 'event -> BBQS Consortium (organizer; MIT is the venue)');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES (_item, _label, 'error', SQLSTATE || ': ' || SQLERRM);
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [notices-04] Each funding call's issuer, from its own FON -> resources.organization_id
-- All 14 calls are isolated: the exporter writes literals only for them (kg/bbqs_kg.py:339-350) and
-- no spine row names an organization. FundingOpportunity already inherits part_of_org (Entity slot,
-- kg/bbqs.linkml.yaml:79, :470 'resources.organization_id'), which the exporter writes for every
-- spine row (kg/bbqs_kg.py:154-155), so the issuer goes there with no code change.
-- The issuer is read off the record itself (Principle III): an NIH Funding Opportunity Number names
-- the issuing component in its second field (RFA-NS-... NINDS, RFA-DA-... NIDA, NOT-MH-... NIMH,
-- RFA-RM-... the Common Fund in the NIH Office of the Director; the PRIMED-AI calls' notes give
-- ODPRIMED-AI@od.nih.gov); 'NSF 26-526' is NSF's own solicitation number (nsf.gov url); the Simons
-- call's title says '(Simons Foundation)' and its url is simonsfoundation.org. Every target
-- organization is already a node: #512's 20261103130000 created them, each with its spine row.
-- Only an EMPTY column is filled. The forecast RFA-NS-26-011 is listed last as a fallback: notices-03
-- deletes it, and if notices-03 was skipped this still links it to NINDS, so it is not left isolated.
-- Whether the issuer is also among the call's own participating_orgs / funding_opportunity_orgs is
-- reported, never required (the FON is the authority).
CREATE OR REPLACE FUNCTION pg_temp.kg_b_notices_04() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  r      record;
  _item  constant text := 'funding call issuer';
  _type  text;
  _cur   uuid;
  _fo    public.funding_opportunities%ROWTYPE;
  _org   uuid;
  _n     int;
  _xref  text;
  _foo   boolean := to_regclass('public.funding_opportunity_orgs') IS NOT NULL;
  _hit   boolean;
  _has_fo boolean;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  FOR r IN
    SELECT * FROM (VALUES
      ('9fe36a51-d470-42f8-baa1-0c7aa68a9dea'::uuid, 'RFA-NS-27-002',         'NINDS',                '69aa906c-2a0c-4524-8958-4e1009f96060'::uuid, 'National Institute of Neurological Disorders and Stroke'),
      ('3fb868da-b941-439e-a81e-927a543defd3'::uuid, 'RFA-NS-25-018',         'NINDS',                '69aa906c-2a0c-4524-8958-4e1009f96060'::uuid, 'National Institute of Neurological Disorders and Stroke'),
      ('07448ab8-2717-4b6e-83e0-9abf492240e5'::uuid, 'RFA-NS-25-016',         'NINDS',                '69aa906c-2a0c-4524-8958-4e1009f96060'::uuid, 'National Institute of Neurological Disorders and Stroke'),
      ('912f67fc-5862-47a2-b6f4-891fcd98f244'::uuid, 'RFA-NS-27-001',         'NINDS',                '69aa906c-2a0c-4524-8958-4e1009f96060'::uuid, 'National Institute of Neurological Disorders and Stroke'),
      ('8b9d5dda-2b99-4e1c-ba27-968f74ef8b77'::uuid, 'RFA-RM-27-011',         'NIH OD (Common Fund)', '2548a017-fd14-4934-9762-b30d7071821a'::uuid, 'NIH Office of the Director (Common Fund)'),
      ('09e37e7e-a6a7-409a-b532-9f000647f007'::uuid, 'RFA-RM-27-012',         'NIH OD (Common Fund)', '2548a017-fd14-4934-9762-b30d7071821a'::uuid, 'NIH Office of the Director (Common Fund)'),
      ('ac01b838-9803-4a39-8adf-6b9ac9883535'::uuid, 'RFA-RM-27-013',         'NIH OD (Common Fund)', '2548a017-fd14-4934-9762-b30d7071821a'::uuid, 'NIH Office of the Director (Common Fund)'),
      ('9db8fc93-1890-4237-b758-d5f94c5e6306'::uuid, 'RFA-RM-27-014',         'NIH OD (Common Fund)', '2548a017-fd14-4934-9762-b30d7071821a'::uuid, 'NIH Office of the Director (Common Fund)'),
      ('b76af5cd-30c7-4f75-a127-d4e8a669cdd6'::uuid, 'RFA-RM-27-015',         'NIH OD (Common Fund)', '2548a017-fd14-4934-9762-b30d7071821a'::uuid, 'NIH Office of the Director (Common Fund)'),
      ('67d25d9e-afa4-4571-aa3c-3c0d4aee3388'::uuid, 'NOT-MH-25-155',         'NIMH',                 '28609b98-6f97-4a46-b875-9f5084f1c7cd'::uuid, 'National Institute of Mental Health'),
      ('d3423658-1147-421f-a6f8-f31067133351'::uuid, 'RFA-DA-27-004',         'NIDA',                 '32f761ce-6857-451c-9eb7-fc5b8b221449'::uuid, 'National Institute on Drug Abuse'),
      ('20adc9fb-c389-48a7-85ec-931501f0ce13'::uuid, 'SIMONS-EMPIRE-AI-2026', 'Simons Foundation',    '1a88610e-c3bc-41b8-a97e-36698d0b0c28'::uuid, 'Simons Foundation'),
      ('a8990457-e9da-49eb-9a0c-5b2af1a4ca61'::uuid, 'NSF 26-526',            'NSF',                  '62826284-8258-4f21-af3e-64fc755ef2b2'::uuid, 'National Science Foundation'),
      ('e0042c46-59de-40f6-b53d-8e565cc27a45'::uuid, 'RFA-NS-26-011',         'NINDS',                '69aa906c-2a0c-4524-8958-4e1009f96060'::uuid, 'National Institute of Neurological Disorders and Stroke')
    ) AS v(rid, fon, acronym, org_rid, org_label)
  LOOP
    BEGIN
      SELECT resource_type::text, organization_id INTO _type, _cur FROM public.resources WHERE id = r.rid;
      IF NOT FOUND THEN
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES (_item, r.fon, CASE WHEN r.fon = 'RFA-NS-26-011' THEN 'noop' ELSE 'skipped' END,
                CASE WHEN r.fon = 'RFA-NS-26-011' THEN 'gone: merged into RFA-NS-27-002 by notices-03 (or deleted earlier)'
                     ELSE format('spine row %s no longer exists', r.rid) END);
        CONTINUE;
      END IF;
      SELECT * INTO _fo FROM public.funding_opportunities WHERE resource_id = r.rid AND fon = r.fon;
      _has_fo := FOUND;
      IF _type <> 'funding' OR NOT _has_fo THEN
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES (_item, r.fon, 'skipped',
                format('spine row %s is typed %s and %s; not touched', r.rid, _type,
                       CASE WHEN _has_fo THEN 'has its detail row' ELSE 'no funding_opportunities row with this fon points at it' END));
        CONTINUE;
      END IF;
      _org := pg_temp.kg_org_of(r.org_rid, r.org_label);
      IF _org IS NULL THEN
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES (_item, r.fon, 'skipped',
                format('organization %s (spine %s) not found with an organizations row on a spine row', r.org_label, r.org_rid));
        CONTINUE;
      END IF;
      IF _cur IS NOT NULL THEN
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES (_item, r.fon, CASE WHEN _cur = _org THEN 'noop' ELSE 'skipped' END,
                CASE WHEN _cur = _org THEN 'already ' || r.org_label
                     ELSE format('already linked to %s; left as is (the FON says %s)',
                                 (SELECT name FROM public.organizations WHERE id = _cur), r.acronym) END);
        CONTINUE;
      END IF;

      -- Cross-check against the call's own funder list (report only).
      _xref := CASE WHEN r.acronym = ANY (coalesce(_fo.participating_orgs, '{}')) THEN 'listed in participating_orgs'
                    WHEN cardinality(coalesce(_fo.participating_orgs, '{}')) = 0 THEN 'participating_orgs is empty'
                    ELSE format('NOT in participating_orgs %s', _fo.participating_orgs) END;
      IF _foo THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.funding_opportunity_orgs WHERE funding_opportunity_id = $1 AND organization_id = $2)'
          INTO _hit USING _fo.id, _org;
        _xref := _xref || CASE WHEN _hit THEN '; in funding_opportunity_orgs' ELSE '; not in funding_opportunity_orgs' END;
      END IF;

      UPDATE public.resources SET organization_id = _org, updated_at = now()
       WHERE id = r.rid AND organization_id IS NULL;
      GET DIAGNOSTICS _n = ROW_COUNT;
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, r.fon, CASE WHEN _n = 1 THEN 'done' ELSE 'noop' END,
              format('call -> %s (issuer by FON); %s', r.org_label, _xref));
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, r.fon, 'error', SQLSTATE || ': ' || SQLERRM);
    END;
  END LOOP;

  -- Any other call in the graph that still has no organization (one added after the 11-04 export,
  -- say): reported for a curator, never guessed.
  FOR r IN
    SELECT s.id, s.name, f.fon
      FROM public.resources s LEFT JOIN public.funding_opportunities f ON f.resource_id = s.id
     WHERE s.resource_type::text = 'funding' AND s.organization_id IS NULL
       AND s.id NOT IN ('9fe36a51-d470-42f8-baa1-0c7aa68a9dea', '3fb868da-b941-439e-a81e-927a543defd3',
                        '07448ab8-2717-4b6e-83e0-9abf492240e5', '912f67fc-5862-47a2-b6f4-891fcd98f244',
                        '8b9d5dda-2b99-4e1c-ba27-968f74ef8b77', '09e37e7e-a6a7-409a-b532-9f000647f007',
                        'ac01b838-9803-4a39-8adf-6b9ac9883535', '9db8fc93-1890-4237-b758-d5f94c5e6306',
                        'b76af5cd-30c7-4f75-a127-d4e8a669cdd6', '67d25d9e-afa4-4571-aa3c-3c0d4aee3388',
                        'd3423658-1147-421f-a6f8-f31067133351', '20adc9fb-c389-48a7-85ec-931501f0ce13',
                        'a8990457-e9da-49eb-9a0c-5b2af1a4ca61', 'e0042c46-59de-40f6-b53d-8e565cc27a45')
  LOOP
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, coalesce(r.fon, r.name), 'report',
            format('funding spine row %s (not in the 11-04 export) has no organization; a curator sets its issuer', r.id));
  END LOOP;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [tools-02] Lightning Pose (3ba48c59) -> COLUMBIA UNIVERSITY HEALTH SCIENCES
-- The exporter already writes resources.organization_id as part_of_org for every class
-- (kg/bbqs_kg.py:154-155), so filling it links the node on the next export. Only where empty; only
-- where a repo or data statement about the resource itself names the organization. Organizations
-- implied only by a URL host or a GitHub account are block tools-07 (commented out).
-- tools-02. Lightning Pose -> COLUMBIA UNIVERSITY HEALTH SCIENCES. The row's own description: "Developed
-- by Liam Paninski's lab at Columbia University Zuckerman Institute" (both Lightning Pose rows, every
-- export since 2026-09-21). 9f75488b is the only Columbia node; people-07 links 'Columbia University'
-- members to it too. Runs after tools-01, on the surviving row; re-checks the description at run time.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_tools_02() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  PERFORM pg_temp.kg_tools_set_org(
    'org: Lightning Pose', '3ba48c59-bb79-44ef-8569-ca644775d73a', 'Lightning Pose', 'software',
    '9f75488b-59d0-4d50-b7db-869f26066743', 'COLUMBIA UNIVERSITY HEALTH SCIENCES',
    (SELECT r.description ILIKE '%Columbia University%' FROM public.resources r
      WHERE r.id = '3ba48c59-bb79-44ef-8569-ca644775d73a'),
    'its own description: "Developed by Liam Paninski''s lab at Columbia University Zuckerman Institute"');
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [tools-03] Psych-DS -> MASSACHUSETTS INSTITUTE OF TECHNOLOGY
-- tools-03. Psych-DS -> MASSACHUSETTS INSTITUTE OF TECHNOLOGY. src/pages/SFN2025.tsx:369 lists "Psych-DS:
-- FAIR data standard — Melissa Kline Struhl (MIT)"; she chairs WG-Standards
-- (src/data/working-group-chairs.ts:9). Re-checked at run time: her record (0f3bb33c, not the
-- double-space stub 99e94e46) is still affiliated with that MIT node. Psych-DS is funded outside BBQS
-- (RF1MH132747), so this is the standard's home, not a BBQS award.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_tools_03() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  PERFORM pg_temp.kg_tools_set_org(
    'org: Psych-DS', '8e67d548-47b3-4b48-9a70-e5e22c56f062',
    'Psych-DS: A FAIR data standard for behavioral datasets', 'standard',
    '7924e7d9-5b53-4525-95ef-3f5a6b9112a5', 'MASSACHUSETTS INSTITUTE OF TECHNOLOGY',
    EXISTS (SELECT 1 FROM public.investigator_organizations io
              JOIN public.investigators i ON i.id = io.investigator_id
             WHERE i.resource_id = '0f3bb33c-e7ee-4013-af5d-894d1adfa0ee'
               AND pg_temp.kg_norm(i.name) = 'melissa kline struhl'
               AND io.organization_id = pg_temp.kg_org_of('7924e7d9-5b53-4525-95ef-3f5a6b9112a5',
                                                          'MASSACHUSETTS INSTITUTE OF TECHNOLOGY')),
    'SFN2025.tsx:369 "Psych-DS: FAIR data standard — Melissa Kline Struhl (MIT)"; her record is an MIT member');
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D06] Link the EMBER collections 000469, 000470, 000471, 000474 to R24MH136632 (roster evidence)
-- Pose Zoo / Pozu (bounding boxes, labels, transcoding) and BBQS Snippets: consortium-wide
-- collections on EMBER's archive with no award on their DANDI record, so neither the sync nor the
-- exporter links them. The curator route #517 block 10 used for 000207 and 000598. Principle III:
-- the link is written only when the dandiset's own DANDI record names someone on R24MH136632's
-- roster (contact_name, or a Person contributor by ORCID or name). Otherwise the call skips with
-- the contact's name in the report, and datasets-O2b links it on a curator's yes.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d06() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  PERFORM pg_temp.kg_ds_link('link EMBER collection', '000469', 'b5f65a35-ad99-4779-ab8c-2f211803ca2e', 'bounding box', 'R24MH136632', 'roster', 'EMBER''s own consortium collection on EMBER-DANDI (#444 lists it under R24MH136632 EMBER); no award on the DANDI record.');  -- Pose Zoo: Bounding Box (mirror: Pozu: Bounding Box)
  PERFORM pg_temp.kg_ds_link('link EMBER collection', '000470', '0c4561e1-221b-4444-ac15-6c2220beb292', '(pozu|pose zoo).*label', 'R24MH136632', 'roster', 'EMBER''s own consortium collection on EMBER-DANDI (#444 lists it under R24MH136632 EMBER); no award on the DANDI record.');  -- Pozu: Labels
  PERFORM pg_temp.kg_ds_link('link EMBER collection', '000471', '1e988b46-bfe4-4e41-843e-b6b0ae88efcb', '(pozu|pose zoo).*transcod', 'R24MH136632', 'roster', 'EMBER''s own consortium collection on EMBER-DANDI (#444 lists it under R24MH136632 EMBER); no award on the DANDI record.');  -- Pozu: Transcoding
  PERFORM pg_temp.kg_ds_link('link EMBER collection', '000474', '1cabb668-d89d-4bbb-a9c2-ea79f7a93708', 'bbqs snippets', 'R24MH136632', 'roster', 'EMBER''s own consortium collection on EMBER-DANDI (#444 lists it under R24MH136632 EMBER); no award on the DANDI record.');  -- BBQS Snippets
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D07] Link 'Four-choice reversal digging task' (000607) to R34DA062119
-- The real dataset of the IDP/ARC platform whose 26 test copies D02 hides: "An Aggregate Dandiset
-- for Four-choice reversal digging task in MAABCD". R34DA062119 is the Adversity and Resilience
-- Consortium (keyword 'International Development Project'); #506 calls 000607 the Wilbrecht-lab
-- dataset; the mirror's contact_name is 'Wilbrecht, Linda' (roundtrip.json row order), and Linda
-- Wilbrecht is R34DA062119's contact_pi on the RePORTER roster. Guarded on the live contact_name.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d07() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  PERFORM pg_temp.kg_ds_link('link 000607 to ARC', '000607', '44376171-f0d7-4e91-9c91-6558f6253fe3', '^\s*four-choice reversal digging task(?!.*idp)', 'R34DA062119', 'contact:wilbrecht',
    'Aggregate dataset of R34DA062119''s IDP/ARC four-choice digging task (#506: the real Wilbrecht-lab dataset; its 26 test copies are hidden).');
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D08] Link datasets whose own DANDI record names a BBQS award the sync's parser dropped
-- ember-dandiset-sync keeps an awardNumber only if /\d?([A-Z]\d{2}[A-Z]{2}\d{6})/ matches it after
-- removing whitespace (index.ts:13-20, 113-117), and silently drops 'DA059723', 'R34-DA059723',
-- 'MH-136632' and the like. This pass reads raw->'contributor'[*].awardNumber (the record of
-- record, Principle III), folds it to upper-case letters and digits, and links the dataset to the
-- BBQS grant whose institute code + serial (e.g. DA059723) it contains. Only datasets with a node
-- (resource_id), not hidden, and with no grant_dandisets row yet. match_source 'curator', not
-- 'award_number': the sync deletes its own 'award_number' rows whenever it parses any award on the
-- record (index.ts:183-189), which would erase this link. matched_award records which grant matched.
-- Offline it is unknown whether any row qualifies (roundtrip.json shows raw but not its awards).
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d08() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  _d   record;
  _g   record;
  _txt text;
  _gd  uuid;
  _n   int := 0;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');
  FOR _d IN
    SELECT d.id, d.dandiset_id, d.name, d.raw, d.award_numbers
      FROM public.dandisets d
     WHERE d.instance = 'ember' AND NOT coalesce(d.hidden, false) AND d.resource_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.grant_dandisets gd WHERE gd.dandiset_id = d.id)
     ORDER BY d.dandiset_id
  LOOP
    SELECT string_agg(regexp_replace(upper(c ->> 'awardNumber'), '[^A-Z0-9]', '', 'g'), ' ')
      INTO _txt
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(_d.raw -> 'contributor') = 'array'
                                     THEN _d.raw -> 'contributor' ELSE '[]'::jsonb END) AS c
     WHERE nullif(btrim(c ->> 'awardNumber'), '') IS NOT NULL;
    CONTINUE WHEN _txt IS NULL;

    FOR _g IN
      SELECT g.id, g.grant_number
        FROM public.grants g
       WHERE g.resource_id IS NOT NULL
         AND g.grant_number ~ '^[A-Z][0-9A-Z]{2}[A-Z]{2}[0-9]{6}$'
         AND position(substring(g.grant_number FROM 4) IN _txt) > 0
       ORDER BY g.grant_number
    LOOP
      BEGIN
        INSERT INTO public.grant_dandisets (grant_id, dandiset_id, match_source, matched_award)
        VALUES (_g.id, _d.id, 'curator', _g.grant_number)
        ON CONFLICT (grant_id, dandiset_id) DO NOTHING
        RETURNING id INTO _gd;
        IF _gd IS NOT NULL THEN
          PERFORM public.record_field_provenance(
            'grant_dandisets', _gd, 'matched_award', 'curator_fill', 'award_text_on_dandi_record',
            NULL, 'EMBER-DANDI ' || _d.dandiset_id || ' raw.contributor[].awardNumber', _g.grant_number,
            format('The DANDI record names award text %L, which contains %s (%s); ember-dandiset-sync''s parser drops that spelling.',
                   _txt, substring(_g.grant_number FROM 4), _g.grant_number));
          INSERT INTO kg_fix_report (item, target, outcome, detail)
          VALUES ('award text on the DANDI record', _d.dandiset_id || ' ' || _d.name || ' -> ' || _g.grant_number,
                  'done', format('linked: award text %L names %s', _txt, _g.grant_number));
          _n := _n + 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES ('award text on the DANDI record', _d.dandiset_id || ' -> ' || _g.grant_number, 'error', SQLSTATE || ': ' || SQLERRM);
      END;
    END LOOP;
  END LOOP;
  IF _n = 0 THEN
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES ('award text on the DANDI record', 'all unlinked dandisets', 'noop',
            'no unlinked dataset''s DANDI record names a BBQS award in a spelling the sync dropped');
  END IF;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [tools-04] Create public.resource_links (audited, anon-readable, typed by LinkML slot)
-- Every KG node is a resources row, so one table can carry the links the schema declares but no
-- table stores: MLModel trained_on Dataset, Benchmark evaluates SoftwareTool/MLModel, any Entity
-- was_attributed_to an Agent, Project produced an artifact. predicate is the kg/bbqs.linkml.yaml slot
-- name, which is also the predicate the exporter writes (bbqs:<slot>, as CQ31 queries it):
--   trained_on        MLModel.slots (:270), range Dataset (:562)         -> ml_model  to dataset|benchmark
--   evaluates         Benchmark.slots (:255), range Entity (:556)        -> benchmark to software|tool|ml_model
--   was_attributed_to Entity.slots (:85), range Agent (:477)             -> any node  to investigator|organization|device_manufacturer
--   produced          Project.slots (:210), range Entity (:512)          -> grant     to an artifact type
-- (Benchmark is_a Dataset, :251. The Agents are Person and Organization, :91-92: Investigator,
-- ResearchOrganization and DeviceManufacturer mix them in, :103-155.) A CHECK cannot read the
-- other rows, so a trigger enforces each slot's domain and range. Readable by anon (the exporter
-- reads it with the anon key); written by admins and the service role, like #512's link tables.
-- Audited the way 20261106120000 (#512) audits its link tables (trg_audit_<table>, which the
-- provenance event trigger does NOT attach by itself); RLS is enabled because Supabase's default
-- privileges grant a new table to anon and authenticated. Each piece is created only if missing, so a
-- re-run changes nothing. A table of this name with another shape stops the whole run (error row:
-- nothing is applied). The rows become graph edges only once kg/bbqs_kg.py reads the table (tools-11).
CREATE OR REPLACE FUNCTION pg_temp.kg_b_tools_04() RETURNS void LANGUAGE plpgsql AS
$blk$
DECLARE
  _existed boolean := to_regclass('public.resource_links') IS NOT NULL;
  _did     text[] := '{}';
  _missing text;
  _n       int;
BEGIN
  IF NOT _existed THEN
    CREATE TABLE public.resource_links (
      id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      subject_id uuid        NOT NULL REFERENCES public.resources(id) ON DELETE CASCADE,
      predicate  text        NOT NULL,
      object_id  uuid        NOT NULL REFERENCES public.resources(id) ON DELETE CASCADE,
      basis      text        NOT NULL REFERENCES public.source_classes(code),
      evidence   text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT resource_links_predicate_check
        CHECK (predicate IN ('trained_on', 'evaluates', 'was_attributed_to', 'produced')),
      CONSTRAINT resource_links_not_self CHECK (subject_id <> object_id),
      CONSTRAINT resource_links_evidence_check CHECK (btrim(evidence) <> ''),
      CONSTRAINT resource_links_unique UNIQUE (subject_id, predicate, object_id)
    );
    COMMENT ON TABLE public.resource_links IS
      'Curated links between two resources (KG nodes) that no column holds. predicate = a kg/bbqs.linkml.yaml slot; the exporter writes (subject, bbqs:<predicate>, object). Only evidenced links: evidence cites the record or repo statement.';
    COMMENT ON COLUMN public.resource_links.basis IS
      'Grade of the evidence, in the provenance vocabulary (source_classes.code), e.g. curator_fill for a curator''s reading of the repo or data.';
    COMMENT ON COLUMN public.resource_links.evidence IS
      'Where the link is stated: file:line, record id, or the person who confirmed it.';
    GRANT SELECT ON public.resource_links TO anon, authenticated;
    GRANT ALL ON public.resource_links TO service_role;
    _did := _did || 'table'::text;
  END IF;

  -- A table of this name that some other change created with a different shape would make every
  -- statement below misbehave: stop (the runner then rolls the whole script back).
  SELECT string_agg(c, ', ') INTO _missing
    FROM unnest(ARRAY['id', 'subject_id', 'predicate', 'object_id', 'basis', 'evidence', 'created_at', 'updated_at']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = 'public.resource_links'::regclass AND a.attname = c
                        AND a.attnum > 0 AND NOT a.attisdropped);
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'public.resource_links already exists without column(s) %; nothing in this script was applied', _missing;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indrelid = 'public.resource_links'::regclass AND i.indisunique
                    AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                          WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey))
                        = ARRAY['object_id', 'predicate', 'subject_id']) THEN
    RAISE EXCEPTION 'public.resource_links already exists without a unique key on (subject_id, predicate, object_id); nothing in this script was applied';
  END IF;

  IF to_regclass('public.resource_links_object_id_idx') IS NULL THEN
    CREATE INDEX resource_links_object_id_idx ON public.resource_links (object_id);
    _did := _did || 'index'::text;
  END IF;

  -- Domain and range per predicate, from the LinkML slots above.
  IF to_regprocedure('public.resource_links_check_types()') IS NULL THEN
    CREATE FUNCTION public.resource_links_check_types()
    RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS
    $fn$
    DECLARE _s text; _o text;
    BEGIN
      SELECT r.resource_type::text INTO _s FROM public.resources r WHERE r.id = NEW.subject_id;
      SELECT r.resource_type::text INTO _o FROM public.resources r WHERE r.id = NEW.object_id;
      IF NOT coalesce(CASE NEW.predicate
           WHEN 'trained_on'        THEN _s = 'ml_model'  AND _o IN ('dataset', 'benchmark')
           WHEN 'evaluates'         THEN _s = 'benchmark' AND _o IN ('software', 'tool', 'ml_model')
           WHEN 'was_attributed_to' THEN _s IS NOT NULL   AND _o IN ('investigator', 'organization', 'device_manufacturer')
           WHEN 'produced'          THEN _s = 'grant'
                                     AND _o IN ('publication', 'dataset', 'software', 'tool', 'ml_model', 'protocol', 'benchmark')
         END, false) THEN
        RAISE EXCEPTION 'resource_links: % cannot link a % to a %',
          NEW.predicate, coalesce(_s, '(missing row)'), coalesce(_o, '(missing row)')
          USING ERRCODE = 'check_violation',
                HINT = 'Each predicate is a kg/bbqs.linkml.yaml slot with a fixed domain and range; see the table comment.';
      END IF;
      RETURN NEW;
    END
    $fn$;
    _did := _did || 'resource_links_check_types()'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.resource_links'::regclass
                    AND tgname = 'trg_resource_links_check_types' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_resource_links_check_types BEFORE INSERT OR UPDATE ON public.resource_links
      FOR EACH ROW EXECUTE FUNCTION public.resource_links_check_types();
    _did := _did || 'trg_resource_links_check_types'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.resource_links'::regclass
                    AND tgname = 'update_resource_links_updated_at' AND NOT tgisinternal) THEN
    CREATE TRIGGER update_resource_links_updated_at BEFORE UPDATE ON public.resource_links
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    _did := _did || 'update_resource_links_updated_at'::text;
  END IF;
  -- Principle X: the same audit trigger every audited table uses (20260810160000, 20261106120000).
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.resource_links'::regclass
                    AND tgname = 'trg_audit_resource_links' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_audit_resource_links AFTER INSERT OR UPDATE OR DELETE ON public.resource_links
      FOR EACH ROW EXECUTE FUNCTION public.log_data_change();
    _did := _did || 'trg_audit_resource_links'::text;
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.resource_links'::regclass) THEN
    ALTER TABLE public.resource_links ENABLE ROW LEVEL SECURITY;
    _did := _did || 'RLS'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.resource_links'::regclass
                    AND polname = 'anyone may read resource links') THEN
    CREATE POLICY "anyone may read resource links" ON public.resource_links FOR SELECT USING (true);
    _did := _did || 'read policy'::text;
  END IF;

  -- The provenance guard, now that the table carries a uuid id (20261106120000:29). Returns how many
  -- triggers it newly attached anywhere; 0 is fine (the ddl event trigger already did it).
  SELECT public.provenance_attach_all() INTO _n;
  IF coalesce(_n, 0) > 0 THEN
    _did := _did || format('%s provenance trigger(s)', _n);
  END IF;
  -- Let PostgREST (the exporter's anon read) see the new table now rather than at its next reload.
  IF cardinality(_did) > 0 THEN
    PERFORM pg_notify('pgrst', 'reload schema');
  END IF;

  INSERT INTO kg_fix_report (item, target, outcome, detail)
  SELECT 'resource_links table', 'public.resource_links',
         CASE WHEN cardinality(_did) > 0 THEN 'done' ELSE 'noop' END,
         format('%s; triggers: %s; policies: %s',
                CASE WHEN cardinality(_did) > 0 THEN 'created: ' || array_to_string(_did, ', ') ELSE 'already present' END,
                (SELECT string_agg(t.tgname, ', ' ORDER BY t.tgname) FROM pg_trigger t
                  WHERE t.tgrelid = 'public.resource_links'::regclass AND NOT t.tgisinternal),
                (SELECT string_agg(p.polname, ', ' ORDER BY p.polname) FROM pg_policy p
                  WHERE p.polrelid = 'public.resource_links'::regclass));
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [tools-05] Record the five evidenced links in resource_links
-- Each call re-checks, against the live rows, that both ends are still the exported nodes and that
-- the evidence still holds. None of these is an edge until the exporter reads resource_links.

-- tools-05. DLC Model Zoo trained_on the two SuperAnimal datasets. The datasets are DeepLabCut's own
-- SuperAnimal training sets: "Large-scale training data for quadruped pose models" / "Training data
-- for top-view mouse pose estimation" (supabase/functions/seed-resources/index.ts:27-28,
-- src/data/resources.ts:188-203), hosted at huggingface.co/datasets/DeepLabCut/. DLC Model Zoo is
-- "Transfer learning models ... trained on species-specific datasets" for quadrupeds and mice
-- (seed-resources:23, resources.ts:162-169), and the DeepLabCut model zoo is where the SuperAnimal
-- models ship (public/tool_device_registry.json:346: "deeplabcut[gui,modelzoo] for SuperAnimal models").
CREATE OR REPLACE FUNCTION pg_temp.kg_b_tools_05() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  PERFORM pg_temp.kg_tools_link(
    'link', 'de29b286-d343-4108-90d9-3d11f8adc030', 'DLC Model Zoo', 'ml_model', 'trained_on',
    '7d9026cf-064c-4070-a81c-858dc1303c4a', 'SuperAnimal-Quadruped-80K', 'dataset', 'curator_fill',
    'seed-resources/index.ts:23,27; src/data/resources.ts:162-169,188-195 (training data for quadruped pose models); public/tool_device_registry.json:346 (SuperAnimal models ship in the DLC model zoo)',
    (SELECT r.external_url ILIKE '%huggingface.co/datasets/DeepLabCut/SuperAnimal-Quadruped%'
       FROM public.resources r WHERE r.id = '7d9026cf-064c-4070-a81c-858dc1303c4a'));
  PERFORM pg_temp.kg_tools_link(
    'link', 'de29b286-d343-4108-90d9-3d11f8adc030', 'DLC Model Zoo', 'ml_model', 'trained_on',
    'd49fe87c-2047-4788-8247-2130a5e0d931', 'SuperAnimal-TopViewMouse-5K', 'dataset', 'curator_fill',
    'seed-resources/index.ts:23,28; src/data/resources.ts:162-169,196-203 (training data for top-view mouse pose estimation); public/tool_device_registry.json:346',
    (SELECT r.external_url ILIKE '%huggingface.co/datasets/DeepLabCut/SuperAnimal-TopViewMouse%'
       FROM public.resources r WHERE r.id = 'd49fe87c-2047-4788-8247-2130a5e0d931'));

  -- tools-05. DLC Leaderboard evaluates DeepLabCut: "Performance comparison for DLC-based approaches",
  -- "Standardized evaluation for DLC variants" (seed-resources/index.ts:32, src/data/resources.ts:221-228).
  -- Re-checked: the row still says so.
  PERFORM pg_temp.kg_tools_link(
    'link', 'b9f28848-dd76-4bf7-9fd6-a4d1509154eb', 'DLC Leaderboard', 'benchmark', 'evaluates',
    '4009a1f6-c173-495b-9725-bb51571a3cdf', 'DeepLabCut', 'software', 'curator_fill',
    'seed-resources/index.ts:32 and src/data/resources.ts:221-228: "Performance comparison for DLC-based approaches", "Standardized evaluation for DLC variants"',
    (SELECT r.description ILIKE '%DLC%' OR r.metadata ->> 'mlPipeline' ILIKE '%DLC%'
       FROM public.resources r WHERE r.id = 'b9f28848-dd76-4bf7-9fd6-a4d1509154eb'));

  -- tools-05. R34DA059513 produced VCL Benchmark. The benchmark's paper, "Vocal Call Locator Benchmark (VCL)
  -- for localizing rodent vocalizations from multi-channel audio" (PMID 39345431, publication a79d14cd),
  -- is one of R34DA059513's publications (project_publications; public/bbqs_marr.yaml:204), and the
  -- resource is that benchmark ("Vocal Call Locator benchmark: 767,295 rodent sounds ..."). Re-checked
  -- at run time from the roster of record: the project_publications row still credits the paper to the
  -- grant, and both rows still say Vocal Call Locator.
  PERFORM pg_temp.kg_tools_link(
    'link', '492fdfe9-53d5-4926-8ef0-933e957fed18', 'R34DA059513', 'grant', 'produced',
    '4921bfdf-7432-48ac-911d-0cb825184ef1', 'VCL Benchmark', 'benchmark', 'curator_fill',
    'project_publications credits PMID 39345431 "Vocal Call Locator Benchmark (VCL) for localizing rodent vocalizations from multi-channel audio" (publication a79d14cd) to R34DA059513; the resource is that benchmark (public/bbqs_marr.yaml:204)',
    EXISTS (SELECT 1 FROM public.project_publications pp
              JOIN public.projects p      ON p.id = pp.project_id
              JOIN public.grants g        ON g.grant_number = p.grant_number
              JOIN public.publications pub ON pub.id = pp.publication_id
             WHERE g.resource_id = '492fdfe9-53d5-4926-8ef0-933e957fed18'
               AND g.grant_number = 'R34DA059513'
               AND pub.resource_id = 'a79d14cd-ae0e-4bce-b09f-8d16e6e15f7f'
               AND pub.title ILIKE 'Vocal Call Locator Benchmark%')
    AND EXISTS (SELECT 1 FROM public.resources r
                 WHERE r.id = '4921bfdf-7432-48ac-911d-0cb825184ef1' AND r.description ILIKE '%Vocal Call Locator%'));

  -- tools-05. Psych-DS was_attributed_to Melissa Kline Struhl. src/pages/SFN2025.tsx:369 credits "Psych-DS:
  -- FAIR data standard" to her; she chairs WG-Standards (src/data/working-group-chairs.ts:9). The object
  -- is her linked record 0f3bb33c, never the double-space stub 99e94e46 (people-01 deletes that one).
  PERFORM pg_temp.kg_tools_link(
    'link', '8e67d548-47b3-4b48-9a70-e5e22c56f062', 'Psych-DS: A FAIR data standard for behavioral datasets', 'standard',
    'was_attributed_to',
    '0f3bb33c-e7ee-4013-af5d-894d1adfa0ee', 'Melissa Kline Struhl', 'investigator', 'curator_fill',
    'src/pages/SFN2025.tsx:369 "Psych-DS: FAIR data standard — Melissa Kline Struhl (MIT)"; WG-Standards chair (src/data/working-group-chairs.ts:9)',
    EXISTS (SELECT 1 FROM public.investigators i
             WHERE i.resource_id = '0f3bb33c-e7ee-4013-af5d-894d1adfa0ee'
               AND pg_temp.kg_norm(i.name) = 'melissa kline struhl'));
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [tools-06] device_class_crosswalk rows for the isolated device categories
-- project_device_usage (20260806214122:46-70) joins grant_methods_evidence.device_class to
-- device_categories ONLY through device_class_crosswalk, and the exporter at HEAD (06522fc,
-- kg/bbqs_kg.py:302-313) writes each of its rows as Project uses_device_category. 15 crosswalk rows
-- reach 13 categories; these reach the isolated ones. A row adds an edge only where live evidence
-- carries that exact bucket, so each report row says how many grants it reaches now.
--   * Harvester buckets (the reuse list in supabase/functions/harvest-grant-methods-multihop/index.ts:274;
--     hint regexes :345-346): miniscope, fiber_photometry, macroscope, MEG.
--   * The old 32-key BBQS taxonomy (src/pages/Devices.tsx:29-64, device-knowledge-seed/index.ts:26-34),
--     mapped onto the live keys. No harvester is told these names, so each is a no-op unless the LLM
--     happened to emit it; they complete the old -> new key map at no risk.
-- Guards: the target key must exist (FK, ON UPDATE CASCADE); a bucket a curator already mapped to a
-- different category is left alone; MEG only if every grant whose evidence says MEG is an OPM-MEG
-- grant by its own title/abstract (meg_opm is "Optically pumped magnetometer arrays", and the 34
-- keys have no SQUID-MEG category). plethysmography -> ppg is ambiguous (whole-body plethysmography
-- measures breathing) and ships commented out as tools-09.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_tools_06() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  _item constant text := 'device crosswalk';
  m record;
  _ev int; _grants text; _other text; _n int;
  _bad text; _meg_rows int;
BEGIN
  PERFORM public.set_actor('migration:link_isolated_nodes');
  PERFORM public.set_source_class('curator_fill');

  FOR m IN
    SELECT * FROM (VALUES
      ('miniscope',             'neural_imaging',    'harvester bucket, harvest-grant-methods-multihop/index.ts:274,345'),
      ('fiber_photometry',      'neural_imaging',    'harvester bucket, harvest-grant-methods-multihop/index.ts:274,346'),
      ('macroscope',            'neural_imaging',    'harvester bucket, harvest-grant-methods-multihop/index.ts:274,293'),
      ('MEG',                   'meg_opm',           'harvester bucket, harvest-grant-methods-multihop/index.ts:274'),
      ('opm',                   'meg_opm',           'old taxonomy key, Devices.tsx:56 "Optically Pumped Magnetometers"'),
      ('heart_rate_sensors',    'ecg_hr',            'old taxonomy key, Devices.tsx:35 "Heart Rate Sensors"'),
      ('respiration_sensors',   'respiration',       'old taxonomy key, Devices.tsx:41 "Respiration Sensors"'),
      ('intranasal_thermistor', 'respiration',       'old taxonomy key, Devices.tsx:46 "Intranasal Thermistor" (breathing)'),
      ('skin_temperature',      'temperature',       'old taxonomy key, Devices.tsx:58 "Skin Temperature Sensor"'),
      ('cortisol_wearable',     'biofluid',          'old taxonomy key, Devices.tsx:54 "Cortisol Wearable"'),
      ('epinephrine_wearable',  'biofluid',          'old taxonomy key, Devices.tsx:55 "Epinephrine Wearable"'),
      ('rna_sequencing',        'genomics',          'old taxonomy key, Devices.tsx:34 "RNA Sequencing"'),
      ('infrared_cameras',      'infrared_camera',   'old taxonomy key, Devices.tsx:37 "Infrared Cameras"'),
      ('smartphone_camera',     'smartphone_camera', 'old taxonomy key, Devices.tsx:57 "Smartphone Camera"')
    ) AS v(legacy_key, category_key, why)
  LOOP
    SELECT count(*), string_agg(DISTINCT e.seed_grant_number, ', ')
      INTO _ev, _grants
      FROM public.grant_methods_evidence e WHERE m.legacy_key = ANY (e.device_class);

    IF NOT EXISTS (SELECT 1 FROM public.device_categories c WHERE c.key = m.category_key) THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, m.legacy_key || ' -> ' || m.category_key, 'skipped', 'no device_categories row with that key');
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM public.device_class_crosswalk x
                WHERE x.legacy_key = m.legacy_key AND x.category_key = m.category_key) THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, m.legacy_key || ' -> ' || m.category_key, 'noop',
              format('mapping already present; live evidence rows with this bucket: %s (grants: %s)', _ev, coalesce(_grants, 'none')));
      CONTINUE;
    END IF;
    SELECT string_agg(x.category_key, ', ') INTO _other
      FROM public.device_class_crosswalk x WHERE x.legacy_key = m.legacy_key;
    IF _other IS NOT NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, m.legacy_key || ' -> ' || m.category_key, 'skipped',
              format('a curator already maps %s to %s; not adding a second category', m.legacy_key, _other));
      CONTINUE;
    END IF;

    IF m.legacy_key = 'MEG' THEN
      SELECT count(*), string_agg(DISTINCT t.seed_grant_number, ', ') FILTER (WHERE NOT t.opm)
        INTO _meg_rows, _bad
        FROM (SELECT e.seed_grant_number,
                     coalesce(concat_ws(' ', g.title, g.abstract) ~* '(\mopm\M|optically[- ]pumped)', false) AS opm
                FROM public.grant_methods_evidence e
                -- seed numbers may carry the full RePORTER form (1R61MH135114-01): match on the core
                -- award, the way the exporter does (kg/bbqs_kg.py core_award).
                LEFT JOIN public.grants g
                       ON g.grant_number = coalesce(substring(upper(e.seed_grant_number) FROM '[A-Z][A-Z0-9]{2}[A-Z]{2}[0-9]{6}'),
                                                    e.seed_grant_number)
               WHERE 'MEG' = ANY (e.device_class)) t;
      IF _meg_rows = 0 THEN
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES (_item, 'MEG -> meg_opm', 'skipped', 'no live evidence row carries MEG, so the mapping would link nothing today and could mislabel a SQUID-MEG grant later');
        CONTINUE;
      END IF;
      IF _bad IS NOT NULL THEN
        INSERT INTO kg_fix_report (item, target, outcome, detail)
        VALUES (_item, 'MEG -> meg_opm', 'skipped',
                format('MEG evidence is on grant(s) whose title/abstract does not say OPM: %s; a curator decides (no SQUID-MEG category exists)', _bad));
        CONTINUE;
      END IF;
    END IF;

    INSERT INTO public.device_class_crosswalk (legacy_key, category_key)
    VALUES (m.legacy_key, m.category_key)
    ON CONFLICT (legacy_key, category_key) DO NOTHING;
    GET DIAGNOSTICS _n = ROW_COUNT;
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, m.legacy_key || ' -> ' || m.category_key, CASE WHEN _n > 0 THEN 'done' ELSE 'noop' END,
            format('%s; live evidence rows with this bucket: %s (grants: %s)', m.why, _ev, coalesce(_grants, 'none')));
  END LOOP;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-01-report] Remaining orphan spine rows, and person rows with no spine row (read-only)
-- people-01-report. Any OTHER investigator spine row with no investigators row: reported, never deleted here.
--      A same-name person row with no spine row should be ATTACHED to it, not have it deleted.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_people_01_report() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  SELECT 'orphan spine row still present (not deleted)', r.name || ' ' || r.id, 'report',
         coalesce(
           (SELECT CASE WHEN i.resource_id IS NULL
                        THEN format('person row %s (%s) has NO spine row: attach this one with UPDATE public.investigators SET resource_id = %L WHERE id = %L',
                                    i.id, i.name, r.id, i.id)
                        ELSE format('same-name person row %s already has spine %s: this one is a duplicate node; delete it the people-01 way', i.id, i.resource_id) END
              FROM public.investigators i
             WHERE pg_temp.kg_norm(i.name) = pg_temp.kg_norm(r.name)
             ORDER BY (i.resource_id IS NULL) DESC, i.created_at
             LIMIT 1),
           'no investigators row with this name: a curator decides')
         || format(' (spine row created %s)', r.created_at::date)
    FROM public.resources r
   WHERE r.resource_type = 'investigator'
     AND NOT EXISTS (SELECT 1 FROM public.investigators i WHERE i.resource_id = r.id)
   ORDER BY r.name;

  -- people-01-report. The reverse: person rows with no spine row are not nodes at all (onboard_member inserts
  --      without resource_id, 20260811120000). Reported only; giving them a node is a separate change.
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  SELECT 'person row with no spine row (not in the KG)', i.name || ' ' || i.id, 'report',
         'investigators.resource_id is NULL'
    FROM public.investigators i
   WHERE i.resource_id IS NULL
   ORDER BY i.name;
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-11] The 4 name-only records: what their own rows hold (read-only; not fixable by SQL)
-- people-11. The four people the repo knows only by name: what their own rows hold, for the curator.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_people_11() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  SELECT 'name-only person (curator asks them or their PI)', v.label || ' ' || v.rid, 'report',
         CASE WHEN i.id IS NULL THEN 'no investigators row on this spine row: an orphan (see people-01-report)'
              ELSE format('institution=%s; email domain=%s; role=%s; created %s; access request: %s',
                          coalesce(quote_literal(nullif(btrim(i.institution), '')), '(empty)'),
                          coalesce(nullif(split_part(coalesce(i.email, ''), '@', 2), ''), '(none)'),
                          coalesce(quote_literal(nullif(btrim(i.role), '')), '(empty)'),
                          i.created_at::date,
                          coalesce((SELECT format('institution %s, association %s, status %s, filed %s',
                                                  coalesce(quote_literal(a.institution), '-'), coalesce(quote_literal(a.association), '-'),
                                                  a.status, a.created_at::date)
                                      FROM public.access_requests a
                                     WHERE (nullif(btrim(i.email), '') IS NOT NULL AND lower(btrim(a.email)) = lower(btrim(i.email)))
                                        OR pg_temp.kg_norm(a.full_name) = pg_temp.kg_norm(i.name)
                                     ORDER BY a.created_at DESC LIMIT 1), 'none'))
         END
    FROM (VALUES
      ('58c31e98-4899-43df-a516-2ee6781b289e'::uuid, 'Anibal Heinsfeld'),
      ('e7f5f7e5-8074-41a9-b866-bfd7112d37c2'::uuid, 'Chaoyi Zhang'),
      ('17b63cd3-e0b6-47c0-97ca-58ef6197e8e4'::uuid, 'Omid Sharafi'),
      ('2a03a500-1fba-4367-85bb-25ce04eaba0e'::uuid, 'Latane Bullock')
    ) AS v(rid, label)
    LEFT JOIN public.investigators i ON i.resource_id = v.rid;
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-D10] Datasets still unlinked, with their DANDI contact; stale spine names (read-only)
-- One report row per EMBER dandiset that still has a node, is not hidden, and has no project link
-- (no grant_dandisets row, no award on its DANDI record that names a BBQS grant). The contact and
-- the contributors' names are the person to ask (#444 said datasets carry no contributor
-- information; the mirror's contact_name is filled on 50 of 51 rows). The lab datasets 000534,
-- 000532, 000465, 000564, 000479 and the NIA-funded 000466 are expected here: only their labs (an
-- awardNumber on EMBER-DANDI, which the nightly sync links) or a curator can supply the project.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_datasets_d10() RETURNS void LANGUAGE plpgsql AS
$blk$
BEGIN
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  SELECT 'still unlinked (curator / lab)',
         d.dandiset_id || ' ' || d.name,
         'report',
         format('contact %s; %s file(s); DANDI awards %s; contributors: %s',
                coalesce(quote_literal(d.contact_name), '(none)'),
                coalesce(d.file_count::text, '?'),
                coalesce(nullif(array_to_string(d.award_numbers, ', '), ''), 'none'),
                coalesce((SELECT string_agg(coalesce(c ->> 'name', '?')
                                            || coalesce(' [' || nullif(c ->> 'awardNumber', '') || ']', ''), '; ')
                            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.raw -> 'contributor') = 'array'
                                                           THEN d.raw -> 'contributor' ELSE '[]'::jsonb END) AS c),
                         '(none)'))
    FROM public.dandisets d
   WHERE d.instance = 'ember'
     AND NOT coalesce(d.hidden, false)
     AND d.resource_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.grant_dandisets gd WHERE gd.dandiset_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.grants g, unnest(coalesce(d.award_numbers, '{}'::text[])) AS a
                      WHERE g.grant_number = a)
   ORDER BY d.dandiset_id;

  -- The spine name the sync wrote once and never refreshes (index.ts:137-138 'kept'); 000469 still
  -- reads 'Pose Zoo: Bounding Box' / 'Testing' while the mirror says 'Pozu: Bounding Box'. Reported,
  -- not changed: the label is not part of the isolation fix.
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  SELECT 'stale spine name', d.dandiset_id, 'report',
         format('resources.name %L <> mirror name %L', r.name, d.name)
    FROM public.dandisets d JOIN public.resources r ON r.id = d.resource_id
   WHERE d.instance = 'ember' AND r.name IS DISTINCT FROM d.name
   ORDER BY d.dandiset_id;
END
$blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [notices-05] Participating-only funder organizations: edges today, funding_opportunity_orgs rows (read-only)
-- (a) The funder organizations that only participate in calls (never the issuer, so notices-04 cannot use
--     them) and that no person or project names. Today's exporter has no edge for them; PR #512's
--     exporter would write one funding_org edge per funding_opportunity_orgs row. Each line counts
--     both, so the admin sees which will still be isolated after #512 merges (0 link rows).
-- (b) Detail rows with no spine row: the exporter cannot node them at all (kg/bbqs_kg.py:140-147,
--     and every detail loop skips a row without resource_id), so new calls and posts are missing
--     from the graph, not isolated, until an insert trigger mints their resources row (README:21, :706).
CREATE OR REPLACE FUNCTION pg_temp.kg_b_notices_05() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  r      record;
  _item  constant text := 'participating-only funder';
  _foo   boolean := to_regclass('public.funding_opportunity_orgs') IS NOT NULL;
  _org   uuid;
  _edges bigint;
  _links bigint;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('c93dcda4-c504-4ca5-a8a5-a62aecf9e841'::uuid, 'National Center for Complementary and Integrative Health'),
      ('c39b3d7a-4ea4-4711-837c-45cef389b959'::uuid, 'National Eye Institute'),
      ('6db7f54b-3093-42cc-8011-007e7c9012f2'::uuid, 'National Institute on Aging'),
      ('ec41db91-9533-4a3c-8956-8ae3d9030c8c'::uuid, 'National Institute on Alcohol Abuse and Alcoholism'),
      ('f1f7e238-efa6-42a5-b5f2-530e56d6cd35'::uuid, 'National Institute of Biomedical Imaging and Bioengineering'),
      ('a6ed8610-4f99-43cb-b0fa-ed983bfa2f20'::uuid, 'National Institute on Deafness and Other Communication Disorders'),
      ('9860f60e-6ccf-44b5-b941-45c88e0ffed7'::uuid, 'NIH Office of Research on Women''s Health'),
      ('d5a4e8e7-26ef-474d-bb33-055d3b151a83'::uuid, 'NIH Office of Behavioral and Social Sciences Research'),
      ('292698fe-d705-45ac-a255-3c699228f21a'::uuid, 'Eunice Kennedy Shriver National Institute of Child Health and Human Development'),
      ('98f1fdd4-77a8-4bd5-8703-ed6fb8c4af0e'::uuid, 'Empire AI Consortium')
    ) AS v(rid, label)
  LOOP
    _org := pg_temp.kg_org_of(r.rid, r.label);
    IF _org IS NULL THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, r.label, 'report', format('organization node %s not found (deleted or renamed)', r.rid));
      CONTINUE;
    END IF;
    -- the edges today's exporter writes for an organization node: part_of_org from any spine row
    -- (bbqs_kg.py:154-155) or project (:237), members from investigator_organizations (:377-380)
    SELECT (SELECT count(*) FROM public.resources WHERE organization_id = _org)
         + (SELECT count(*) FROM public.projects WHERE organization_id = _org)
         + (SELECT count(*) FROM public.investigator_organizations WHERE organization_id = _org)
      INTO _edges;
    _links := NULL;
    IF _foo THEN
      EXECUTE 'SELECT count(*) FROM public.funding_opportunity_orgs WHERE organization_id = $1' INTO _links USING _org;
    END IF;
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES (_item, r.label, 'report',
            CASE WHEN NOT _foo
                 THEN format('%s edge(s) the current exporter writes; funding_opportunity_orgs does not exist here (#512''s 20261103130000 not applied)', _edges)
                 ELSE format('%s edge(s) the current exporter writes; %s funding_opportunity_orgs row(s) for #512''s exporter%s',
                             _edges, _links,
                             CASE WHEN _edges = 0 AND _links = 0
                                  THEN ' -> stays isolated even after #512: no call lists it; a curator decides' ELSE '' END) END);
  END LOOP;

  FOR r IN
    SELECT 'funding_opportunities' AS tbl, count(*) AS n FROM public.funding_opportunities WHERE resource_id IS NULL
    UNION ALL SELECT 'announcements', count(*) FROM public.announcements WHERE resource_id IS NULL
    UNION ALL SELECT 'jobs', count(*) FROM public.jobs WHERE resource_id IS NULL
  LOOP
    IF r.n > 0 THEN
      INSERT INTO kg_fix_report (item, target, outcome, detail)
      VALUES (_item, r.tbl, 'report',
              format('%s row(s) with resource_id NULL: not in the graph at all (no spine row; needs the insert trigger)', r.n));
    END IF;
  END LOOP;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [tools-10] Device-category reach, unmapped buckets, tool nodes still unlinked (read-only)
-- To look again later (read-only):
--   which grants each new mapping reaches, and from how deep in the multihop evidence (0 = the grant's own text):
--   SELECT e.seed_grant_number, x.legacy_key, x.category_key, min(e.depth) AS min_depth, count(*) AS rows
--     FROM public.grant_methods_evidence e CROSS JOIN LATERAL unnest(e.device_class) AS b(bucket)
--     JOIN public.device_class_crosswalk x ON x.legacy_key = b.bucket
--    WHERE x.category_key IN ('meg_opm', 'neural_imaging', 'ecg_hr', 'respiration', 'temperature', 'biofluid',
--                             'genomics', 'infrared_camera', 'smartphone_camera', 'ppg')
--    GROUP BY 1, 2, 3 ORDER BY 3, 1;
--   every bucket still unmapped:
--   SELECT b.bucket, count(DISTINCT e.seed_grant_number) AS grants, min(e.depth) AS min_depth
--     FROM public.grant_methods_evidence e CROSS JOIN LATERAL unnest(e.device_class) AS b(bucket)
--    WHERE NOT EXISTS (SELECT 1 FROM public.device_class_crosswalk x WHERE x.legacy_key = b.bucket)
--    GROUP BY 1 ORDER BY 2 DESC, 1;
CREATE OR REPLACE FUNCTION pg_temp.kg_b_tools_10() RETURNS void LANGUAGE plpgsql AS
$do$
DECLARE
  c record;
  _txt text; _n int;
  _pst uuid[] := '{}'; _linked uuid[] := '{}';
BEGIN
  -- a. Each isolated device category: which grants project_device_usage now gives it. The view reads
  --    the crosswalk inside this transaction, so this is what the next export will write.
  FOR c IN
    SELECT k.key, k.label
      FROM public.device_categories k
     WHERE k.key IN ('meg_opm', 'neural_imaging', 'ecg_hr', 'respiration', 'ppg', 'temperature', 'biofluid',
                     'genomics', 'infrared_camera', 'smartphone_camera', 'imu', 'lidar_radar',
                     'depth_camera', 'survey_task')
     ORDER BY k.key
  LOOP
    SELECT count(DISTINCT u.grant_number), string_agg(DISTINCT u.grant_number, ', ')
      INTO _n, _txt
      FROM public.project_device_usage u WHERE u.category_key = c.key;
    INSERT INTO kg_fix_report (item, target, outcome, detail)
    VALUES ('device category reach', c.key || ' (' || c.label || ')', 'report',
            CASE WHEN _n = 0 THEN 'no project reaches it through project_device_usage: stays isolated after the next export'
                 ELSE format('%s project(s) after the next export: %s', _n, _txt) END);
  END LOOP;

  -- b. Live buckets no crosswalk row maps, most-used first: the list a curator maps by hand.
  SELECT count(*), string_agg(format('%s (%s grants)', t.bucket, t.grants), ', ' ORDER BY t.grants DESC, t.bucket)
           FILTER (WHERE t.rn <= 40)
    INTO _n, _txt
    FROM (SELECT b.bucket, count(DISTINCT e.seed_grant_number) AS grants,
                 row_number() OVER (ORDER BY count(DISTINCT e.seed_grant_number) DESC, b.bucket) AS rn
            FROM public.grant_methods_evidence e
            CROSS JOIN LATERAL unnest(e.device_class) AS b(bucket)
           WHERE NOT EXISTS (SELECT 1 FROM public.device_class_crosswalk x WHERE x.legacy_key = b.bucket)
           GROUP BY b.bucket) t;
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES ('unmapped buckets', 'grant_methods_evidence.device_class', 'report',
          format('%s distinct bucket(s) map to no category; top 40: %s', _n, coalesce(_txt, 'none')));

  -- c. Tool-side nodes the next export will still leave isolated: no organization that has a node,
  --    no resource_links row at either end. #512's project_software_tools links are marked: they
  --    become edges only once #512's exporter half merges. Both tables are read only if present.
  IF to_regclass('public.project_software_tools') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(DISTINCT st.resource_id), ''{}''::uuid[])
               FROM public.software_tools st
               JOIN public.project_software_tools p ON p.software_tool_id = st.id' INTO _pst;
  END IF;
  IF to_regclass('public.resource_links') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(DISTINCT x), ''{}''::uuid[])
               FROM public.resource_links l, unnest(ARRAY[l.subject_id, l.object_id]) AS x' INTO _linked;
  END IF;
  SELECT count(*), string_agg(format('%s %s [%s]%s', r.resource_type, r.name, left(r.id::text, 8),
                                     CASE WHEN r.id = ANY (_pst) THEN ' (#512 uses_software once merged)' ELSE '' END),
                              '; ' ORDER BY r.resource_type, r.name)
    INTO _n, _txt
    FROM public.resources r
   WHERE r.resource_type::text IN ('software', 'tool', 'ml_model', 'benchmark', 'protocol', 'standard')
     AND NOT EXISTS (SELECT 1 FROM public.organizations o
                      WHERE o.id = r.organization_id AND o.resource_id IS NOT NULL)
     AND NOT (r.id = ANY (_linked));
  INSERT INTO kg_fix_report (item, target, outcome, detail)
  VALUES ('tools still unlinked', 'software/tool/ml_model/benchmark/protocol/standard', 'report',
          format('%s node(s) with no organization and no resource link; species, uses_software and the links only a person can supply are not SQL: %s',
                 _n, coalesce(_txt, 'none')));
END
$do$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. OPTIONAL BLOCKS: commented out. Each needs a curator's answer to its QUESTION first.
--    To apply one: uncomment it (from its CREATE line to its closing $...$; line), then run the WHOLE
--    script again (dry run first). Every other block then reports noop. Section 4 runs an
--    uncommented optional block in its place, after the blocks above and before the reports.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-04] OPTIONAL: Give the merged Niegil record the fuller name on both rows
-- QUESTION FOR A CURATOR: Should the merged record be named 'Niegil Francis Muttath Joseph' on both rows? (publications credit him as 'Francis, Niegil')
-- -- people-04 (OPTIONAL). Give the merged Niegil record the fuller name on BOTH rows, as
-- -- 20260826120000 recommends for a person's own name. resources.name is not synced from
-- -- investigators.name (the Neimat spine kept 'Joseph S Neimat'), so both are written. Runs only after
-- -- people-03 merged the duplicate (investigators_name_key: the duplicate held the name), and renames the
-- -- spine row only while the duplicate spine row is gone. Publications credit him as 'Francis, Niegil'
-- -- (public/bbqs_marr.yaml:205), which is why this is not applied by default.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_people_04() RETURNS void LANGUAGE plpgsql AS
-- $blk$
-- DECLARE _n int; _m int;
-- BEGIN
--   UPDATE public.investigators SET name = 'Niegil Francis Muttath Joseph', updated_at = now()
--    WHERE resource_id = 'af80d437-679c-42d0-aeed-fc7129b8a7b7' AND name = 'Niegil Francis'
--      AND NOT EXISTS (SELECT 1 FROM public.investigators WHERE name = 'Niegil Francis Muttath Joseph');
--   GET DIAGNOSTICS _n = ROW_COUNT;
--   UPDATE public.resources SET name = 'Niegil Francis Muttath Joseph', updated_at = now()
--    WHERE id = 'af80d437-679c-42d0-aeed-fc7129b8a7b7' AND name = 'Niegil Francis'
--      AND NOT EXISTS (SELECT 1 FROM public.resources WHERE id = '83e96042-a116-4e27-ab65-787db78d29f2');
--   GET DIAGNOSTICS _m = ROW_COUNT;
--   INSERT INTO kg_fix_report (item, target, outcome, detail)
--   VALUES ('rename the merged Niegil record', 'af80d437-679c-42d0-aeed-fc7129b8a7b7',
--           CASE WHEN _n + _m > 0 THEN 'done' ELSE 'noop' END,
--           format('investigators.name: %s row(s); resources.name: %s row(s) (0 if people-03 did not merge, or already renamed)', _n, _m));
-- END
-- $blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-09] OPTIONAL: Second affiliation for Jongwoon Kim: COLUMBIA UNIVERSITY HEALTH SCIENCES
-- QUESTION FOR A CURATOR: Is Jongwoon Kim at NYU Langone, Columbia, or both today?
-- -- people-09 (OPTIONAL). Jongwoon Kim's second affiliation. His form answer names both
-- -- 'NYU, Columbia University' (20260807150000:182), he holds jk4975@columbia.edu as a secondary
-- -- (seed-consortium/index.ts:70), and the 09-08 seating plan seats him as Columbia
-- -- (mit-workshop-seating.ts:102). people-07 links NYU School of Medicine; this adds Columbia too
-- -- (kg_link_org with _allow_other_orgs = true, because he will already have the NYU link).
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_people_09() RETURNS void LANGUAGE plpgsql AS
-- $blk$
-- BEGIN
--   PERFORM pg_temp.kg_link_org('second affiliation (optional)',
--     'e055175b-7bfb-471e-8e80-d8697b484b9d'::uuid, 'Jongwoon Kim',
--     '9f75488b-59d0-4d50-b7db-869f26066743'::uuid, 'COLUMBIA UNIVERSITY HEALTH SCIENCES',
--     '(nyu|new york univ|langone|columbia)', NULL,
--     'form: NYU, Columbia University, 20260807150000:182; secondary columbia.edu address; seating:102',
--     true);
-- END
-- $blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [people-10-merge] OPTIONAL: Merge 'Jeffrey Walker' (e1424ffb) into 'Jeffery Walker' (7a5a1c11) and take the spelling 'Jeffrey'
-- QUESTION FOR A CURATOR: Are 'Jeffrey Walker' (e1424ffb) and 'Jeffery Walker' (7a5a1c11, Yale) one person? 20260826120000 judged them two people at two institutions; the people-10 report rows show both records.
-- -- Every consortium source knows ONE Walker, at Yale: the seating plan's 'Jeffrey Walker', Yale,
-- -- Research Staff (mit-workshop-seating.ts:120); seed-consortium's 'Jeff Walker', Yale,
-- -- jeffrey.walker@yale.edu (index.ts:685-693); and the WG-Analytics backfill keyed on that address
-- -- (20260807150000:58), which sits on 'Jeffery Walker' (7a5a1c11: postdoc on U01DA063534, YALE
-- -- member). But 20260826120000:274-276 recorded the opposite judgement ("two different
-- -- institutions"), so this merge needs a person's yes. The people-10 report rows print both records.
-- -- On a yes: same steps as people-03, then the keeper takes the spelling both sources use, 'Jeffrey', on
-- -- investigators.name AND resources.name (the spine name is not synced). Skipped if the duplicate's
-- -- institution text names somewhere other than Yale, or it holds a non-Yale address, a roster row,
-- -- a login, or a role/working group the keeper lacks.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_people_10() RETURNS void LANGUAGE plpgsql AS
-- $do$
-- DECLARE
--   _keep_res constant uuid := '7a5a1c11-f5f8-4643-b444-71228b1f298a';  -- 'Jeffery Walker'
--   _drop_res constant uuid := 'e1424ffb-1cc6-4d9a-932e-464c967a68f9';  -- 'Jeffrey Walker'
--   _item     constant text := 'merge Jeffrey Walker -> Jeffery Walker (optional)';
--   _keep public.investigators%ROWTYPE;
--   _drop public.investigators%ROWTYPE;
--   _n int; _refs text; _addr text[]; _bad text; _prov_guard boolean := false; _fp int := 0;
-- BEGIN
--   PERFORM public.set_actor('migration:link_isolated_nodes');
--   PERFORM public.set_source_class('curator_fill');
--   IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = _drop_res) THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'noop', 'duplicate spine row already gone');
--     RETURN;
--   END IF;
--   SELECT * INTO _keep FROM public.investigators WHERE resource_id = _keep_res;
--   IF _keep.id IS NULL OR pg_temp.kg_norm(_keep.name) NOT IN ('jeffery walker', 'jeffrey walker')
--      OR lower(btrim(coalesce(_keep.email, ''))) <> 'jeffrey.walker@yale.edu' THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _keep_res::text, 'skipped', 'keeper is not the Jeffery Walker row holding jeffrey.walker@yale.edu');
--     RETURN;
--   END IF;
--   SELECT count(*) INTO _n FROM public.investigators WHERE resource_id = _drop_res;
--   SELECT * INTO _drop FROM public.investigators WHERE resource_id = _drop_res;
--   IF _n <> 1 OR pg_temp.kg_norm(_drop.name) <> 'jeffrey walker' OR _drop.id = _keep.id THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'skipped', 'duplicate row missing, doubled or renamed');
--     RETURN;
--   END IF;
--   IF nullif(btrim(_drop.institution), '') IS NOT NULL AND _drop.institution !~* 'yale' THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, _drop_res::text, 'skipped', format('duplicate''s institution is %L: two people, as 20260826120000 judged; record its org and grant instead', _drop.institution));
--     RETURN;
--   END IF;
--   _addr := ARRAY(SELECT DISTINCT lower(btrim(e)) FROM unnest(array_append(coalesce(_drop.secondary_emails, '{}'::text[]), _drop.email)) AS e
--                   WHERE nullif(btrim(e), '') IS NOT NULL);
--   SELECT string_agg(e, ', ') INTO _bad FROM unnest(_addr) AS e WHERE e !~ '@yale\.edu$';
--   SELECT count(*) INTO _n FROM public.grant_investigators WHERE investigator_id = _drop.id;
--   IF _bad IS NOT NULL OR _n > 0 OR _drop.user_id IS NOT NULL
--      OR (nullif(btrim(_drop.role), '') IS NOT NULL AND _drop.role IS DISTINCT FROM _keep.role)
--      OR EXISTS (SELECT 1 FROM unnest(coalesce(_drop.working_groups, '{}'::text[])) AS w
--                  WHERE NOT (w = ANY (coalesce(_keep.working_groups, '{}'::text[])))) THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, _drop_res::text, 'skipped',
--             format('not a clean duplicate: non-Yale addresses %s, %s roster row(s), login %s, role %L, working groups %s',
--                    coalesce(_bad, 'none'), _n, coalesce(_drop.user_id::text, 'none'), _drop.role, coalesce(_drop.working_groups::text, '{}')));
--     RETURN;
--   END IF;
--   _refs := pg_temp.kg_fk_refs('public.investigators'::regclass, _drop.id, ARRAY['public.investigator_organizations.investigator_id']);
--   IF _refs = '' THEN
--     _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _drop_res,
--                ARRAY['public.knowledge_embeddings.resource_id', 'public.investigators.resource_id', 'public.entity_comments.resource_id']);
--   END IF;
--   IF _refs <> '' THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'skipped', 'duplicate referenced: ' || _refs);
--     RETURN;
--   END IF;
--   BEGIN
--     DELETE FROM public.investigator_organizations d
--      WHERE d.investigator_id = _drop.id
--        AND EXISTS (SELECT 1 FROM public.investigator_organizations k WHERE k.investigator_id = _keep.id AND k.organization_id = d.organization_id);
--     UPDATE public.investigator_organizations SET investigator_id = _keep.id WHERE investigator_id = _drop.id;
--     UPDATE public.curation_audit_log SET investigator_id = _keep.id WHERE investigator_id = _drop.id;
--     UPDATE public.curation_audit_log SET resource_id = _keep_res WHERE resource_id = _drop_res;
--     UPDATE public.entity_comments SET resource_id = _keep_res WHERE resource_id = _drop_res;
--     IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.field_provenance'::regclass
--                   AND tgname = 'trg_field_provenance_append_only' AND NOT tgisinternal AND tgenabled <> 'D') THEN
--       ALTER TABLE public.field_provenance DISABLE TRIGGER trg_field_provenance_append_only;
--       _prov_guard := true;
--     END IF;
--     UPDATE public.field_provenance SET entity_id = _keep.id WHERE entity_table = 'investigators' AND entity_id = _drop.id;
--     GET DIAGNOSTICS _fp = ROW_COUNT;
--     IF _prov_guard THEN
--       ALTER TABLE public.field_provenance ENABLE TRIGGER trg_field_provenance_append_only;
--     END IF;
--     DELETE FROM public.knowledge_embeddings WHERE resource_id = _drop_res OR source_id::text IN (_drop.id::text, _drop_res::text);
--     DELETE FROM public.investigators WHERE id = _drop.id;              -- frees the name 'Jeffrey Walker'
--     UPDATE public.investigators
--        SET secondary_emails = ARRAY(SELECT DISTINCT lower(btrim(e))
--                                       FROM unnest(coalesce(secondary_emails, '{}'::text[]) || _addr) AS e
--                                      WHERE nullif(btrim(e), '') IS NOT NULL
--                                        AND lower(btrim(e)) <> lower(btrim(coalesce(email, '')))),
--            updated_at = now()
--      WHERE id = _keep.id;
--     -- Only now is the name free (investigators_name_key): merge -> delete -> rename (20260807190000).
--     UPDATE public.investigators SET name = 'Jeffrey Walker', updated_at = now()
--      WHERE id = _keep.id AND name <> 'Jeffrey Walker'
--        AND NOT EXISTS (SELECT 1 FROM public.investigators x WHERE x.name = 'Jeffrey Walker' AND x.id <> _keep.id);
--     UPDATE public.resources SET name = 'Jeffrey Walker', updated_at = now()
--      WHERE id = _keep_res AND name <> 'Jeffrey Walker'
--        AND EXISTS (SELECT 1 FROM public.investigators WHERE id = _keep.id AND name = 'Jeffrey Walker');
--     _refs := pg_temp.kg_fk_refs('public.resources'::regclass, _drop_res, '{}'::text[]);
--     IF _refs <> '' THEN
--       RAISE EXCEPTION 'duplicate spine row still referenced after the repoint: %', _refs;
--     END IF;
--     DELETE FROM public.resources WHERE id = _drop_res;
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, _drop_res::text || ' -> ' || _keep_res::text, 'done',
--             format('merged; keeper renamed Jeffrey Walker on both rows; %s provenance claim(s) re-anchored', _fp));
--   EXCEPTION WHEN OTHERS THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, _drop_res::text, 'error', SQLSTATE || ': ' || SQLERRM);
--   END;
-- END
-- $do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-O1] OPTIONAL: Hide 000598 'EMBER Bees DeepLabCut Training — Workflow Smoke Test' (linked, not isolated)
-- QUESTION FOR A CURATOR: Hide the smoke test #506 lists, although a curator linked it to EMBER on 2026-11-03 (#517 block 10)? It removes a linked node and fixes no isolated one.
-- -- #506 lists it as a test, and its description says "Intended for workflow validation, not as a
-- -- new scientific benchmark". But a curator linked it to R24MH136632 on 2026-11-03 (#517 block 10,
-- -- "the two EMBER datasets, confirmed by a curator"), and it is NOT isolated, so hiding it removes a
-- -- node and its funded_datasets edge and fixes no isolated node. The grant_dandisets row stays, so
-- -- set_dandiset_hidden(ARRAY['000598'], false) restores node and edge. Uncomment on a curator's yes.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_datasets_o1() RETURNS void LANGUAGE plpgsql AS
-- $blk$
-- BEGIN
--   PERFORM pg_temp.kg_ds_hide('hide linked smoke test', '000598', '4f6fe91b-9a18-467b-8a17-46bc3404f22e', 'smoke test', 'workflow smoke test, not a scientific dataset (#506)', true);
-- END
-- $blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-O2a] OPTIONAL: Link the SLEAP re-hosts 000265 and 000398 to R24MH136632 (or hide them)
-- QUESTION FOR A CURATOR: Are 000265 and 000398 (public sleap.ai data re-hosted on EMBER-DANDI) EMBER demos to credit to R24MH136632, or copies to hide (the two commented kg_ds_hide lines inside)?
-- -- 000398 "is an example of how SLEAP training data (flies13 from sleap.ai/datasets.html) can be
-- -- converted and stored on EMBER-DANDI"; 000265 holds "Annotations for testing clip of mice ... from
-- -- sleap.ai/datasets.html". Public SLEAP data re-hosted as an EMBER storage demo, so the honest
-- -- funder of the data is neither EMBER nor a BBQS lab: #444 lists them as 'Related' to the
-- -- SLEAP-using projects (Grover, Sanes, Srivastava), not to EMBER, and the 11-03 curator linked
-- -- 000598 (derived from 000398) but not 000398 itself. A curator chooses: link as EMBER demos
-- -- (below), hide them as throwaway copies (the two commented kg_ds_hide lines), or leave them.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_datasets_o2a() RETURNS void LANGUAGE plpgsql AS
-- $blk$
-- BEGIN
--   PERFORM pg_temp.kg_ds_link('link SLEAP re-host (curator yes)', '000265', '41b331ec-b7ab-400f-9899-6c314e9eea6e', 'sleap annotations', 'R24MH136632', 'curator',
--     'Curator decision: EMBER-DANDI storage demo of public SLEAP data (sleap.ai/datasets.html).');
--   PERFORM pg_temp.kg_ds_link('link SLEAP re-host (curator yes)', '000398', '9cac1ce6-16e0-400b-adda-ad5d2a8597a9', 'sleap training data', 'R24MH136632', 'curator',
--     'Curator decision: EMBER-DANDI storage demo of public SLEAP data (flies13, sleap.ai/datasets.html).');
--   -- PERFORM pg_temp.kg_ds_hide('hide SLEAP re-host', '000265', '41b331ec-b7ab-400f-9899-6c314e9eea6e', 'sleap annotations', 'copy of public SLEAP example data (sleap.ai)');
--   -- PERFORM pg_temp.kg_ds_hide('hide SLEAP re-host', '000398', '9cac1ce6-16e0-400b-adda-ad5d2a8597a9', 'sleap training data', 'copy of public SLEAP example data (sleap.ai)');
-- END
-- $blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-O2b] OPTIONAL: Link whichever EMBER collections D05/D06 skipped for want of roster evidence
-- QUESTION FOR A CURATOR: Does EMBER confirm that each collection datasets-D05/D06 skipped (see their report rows) is its own? Keep only those lines.
-- -- Run only for the dandisets whose D06 report row says 'skipped ... not on R24MH136632's roster',
-- -- after a curator (or EMBER) confirms they are EMBER's. Each call is a no-op if D06 linked it.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_datasets_o2b() RETURNS void LANGUAGE plpgsql AS
-- $blk$
-- BEGIN
--   PERFORM pg_temp.kg_ds_link('link EMBER collection (curator yes)', '000469', 'b5f65a35-ad99-4779-ab8c-2f211803ca2e', 'bounding box', 'R24MH136632', 'curator', 'Curator decision: EMBER''s Pozu collection.');
--   PERFORM pg_temp.kg_ds_link('link EMBER collection (curator yes)', '000470', '0c4561e1-221b-4444-ac15-6c2220beb292', '(pozu|pose zoo).*label', 'R24MH136632', 'curator', 'Curator decision: EMBER''s Pozu collection.');
--   PERFORM pg_temp.kg_ds_link('link EMBER collection (curator yes)', '000471', '1e988b46-bfe4-4e41-843e-b6b0ae88efcb', '(pozu|pose zoo).*transcod', 'R24MH136632', 'curator', 'Curator decision: EMBER''s Pozu collection.');
--   PERFORM pg_temp.kg_ds_link('link EMBER collection (curator yes)', '000474', '1cabb668-d89d-4bbb-a9c2-ea79f7a93708', 'bbqs snippets', 'R24MH136632', 'curator', 'Curator decision: EMBER''s consortium-wide snippet collection.');
--   PERFORM pg_temp.kg_ds_link('link EMBER collection (curator yes)', '000472', '241a21ae-2f3c-4fce-b11d-d42980ed7209', 'missing subjects', 'R24MH136632', 'curator', 'Curator decision: EMBER''s Pozu collection (has files).');
-- END
-- $blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-O3] OPTIONAL: Confirm species candidate Cricket for R34DA059512 (append) + alias cricket -> Gryllidae
-- QUESTION FOR A CURATOR: Does R34DA059512 study the cricket (its prey) as a species? On 2026-11-03 the curator set ['Mus musculus'] only.
-- -- confirm_species_candidate('R34DA059512', 'Cricket', _replace => false) without its auth.uid()
-- -- gate (20260822120000:92-141): append to projects.study_species (array_agg DISTINCT, exactly as the
-- -- function does), then record WHY with the abstract quote. Never replaces: Mus musculus stays.
-- -- Optional because a curator decides whether prey counts as a studied species: on 2026-11-03 the
-- -- curator confirmed R34DA059512's Mus musculus and set study_species to ['Mus musculus'] only
-- -- (#517 block 13), skipping this candidate (20260930140000:25-30, confidence 'strong'). Once
-- -- confirmed, the exporter's resolver matches 'Cricket' on the Cricket species row's name, which
-- -- links the isolated Cricket node. The alias keeps project_species from listing it as 'unmapped'.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_datasets_o3() RETURNS void LANGUAGE plpgsql AS
-- $do$
-- DECLARE
--   _item constant text := 'confirm Cricket for R34DA059512 (append)';
--   _c    record;
--   _p    record;
--   _new  text[];
-- BEGIN
--   PERFORM public.set_actor('migration:link_isolated_nodes');
--   PERFORM public.set_source_class('curator_fill');   -- the projects guard refuses an undeclared write over a curated value
--
--   SELECT * INTO _c FROM public.species_candidates WHERE grant_number = 'R34DA059512' AND candidate = 'Cricket';
--   IF NOT FOUND THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, 'R34DA059512', 'skipped', 'no Cricket candidate (20260930140000 not applied?)');
--     RETURN;
--   END IF;
--   SELECT id, study_species INTO _p FROM public.projects WHERE grant_number = 'R34DA059512';
--   IF NOT FOUND THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, 'R34DA059512', 'skipped', 'no project row');
--     RETURN;
--   END IF;
--   IF EXISTS (SELECT 1 FROM unnest(coalesce(_p.study_species, '{}'::text[])) s WHERE lower(btrim(s)) = 'cricket') THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, 'R34DA059512', 'noop', 'already lists Cricket: ' || array_to_string(_p.study_species, ', '));
--     RETURN;
--   END IF;
--   IF NOT EXISTS (SELECT 1 FROM public.species
--                   WHERE lower(btrim(name)) = 'cricket' OR lower(btrim(common_name)) = 'cricket') THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, 'R34DA059512', 'skipped', 'no Cricket species row: the claim would dangle (shape #7)');
--     RETURN;
--   END IF;
--
--   SELECT array_agg(DISTINCT s) INTO _new
--     FROM unnest(coalesce(_p.study_species, '{}'::text[]) || 'Cricket'::text) AS s;
--   UPDATE public.projects SET study_species = _new WHERE id = _p.id;
--   PERFORM public.record_field_provenance(
--     'projects', _p.id, 'study_species', 'curator_fill', 'confirmed_species_candidate',
--     NULL, _c.source, array_to_string(_new, ', '),
--     format('Confirmed by %s from the grant abstract: "%s"', public.current_actor_via(), _c.evidence));
--
--   INSERT INTO public.species_aliases (alias, canonical, kind, common_name, note)
--   VALUES ('cricket', 'Gryllidae', 'taxon_assumed', 'cricket',
--           'Prey in R34DA059512''s prey-capture paradigm ("prey (cricket)"); the abstract does not name the species, so family level is a judgement.')
--   ON CONFLICT (alias) DO NOTHING;
--
--   INSERT INTO kg_fix_report (item, target, outcome, detail)
--   VALUES (_item, 'R34DA059512', 'done',
--           format('study_species %s -> %s; alias cricket -> Gryllidae (taxon_assumed)',
--                  array_to_string(coalesce(_p.study_species, '{}'::text[]), ', '), array_to_string(_new, ', ')));
-- EXCEPTION WHEN OTHERS THEN
--   INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, 'R34DA059512', 'error', SQLSTATE || ': ' || SQLERRM);
-- END
-- $do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-O4] OPTIONAL: Alias 'drosophila' -> Drosophila melanogaster (Fruit Fly) for JAABA
-- QUESTION FOR A CURATOR: Is a 'drosophila' -> Drosophila melanogaster alias wanted? (Probably a no-op: the Fruit Fly row is named 'Drosophila'.)
-- -- seed-resources gives JAABA the species text 'Drosophila (fruit flies)' (index.ts:14). No exporter
-- -- reads resources.metadata.species yet (the tools group's supports_species change does), so this
-- -- links nothing today. It is also redundant while the Fruit Fly species row's own name is
-- -- 'Drosophila' (2026-09-21 export; roundtrip.json shows 11 of 15 species names differ from the spine
-- -- names), because the resolver keys on species.name too (kg/bbqs_kg.py:177-187); the block then
-- -- writes nothing. 'taxon_assumed': the genus read as D. melanogaster is a judgement.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_datasets_o4() RETURNS void LANGUAGE plpgsql AS
-- $do$
-- DECLARE _item constant text := 'alias drosophila -> Fruit Fly';
-- BEGIN
--   PERFORM public.set_actor('migration:link_isolated_nodes');
--   PERFORM public.set_source_class('curator_fill');
--   IF EXISTS (SELECT 1 FROM public.species_aliases WHERE alias = 'drosophila') THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     SELECT _item, 'species_aliases', 'noop', 'alias exists: drosophila -> ' || coalesce(canonical, '(none)')
--       FROM public.species_aliases WHERE alias = 'drosophila';
--   ELSIF EXISTS (SELECT 1 FROM public.species WHERE lower(btrim(name)) = 'drosophila' OR lower(btrim(common_name)) = 'drosophila') THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, 'species_aliases', 'noop', 'redundant: a species row is itself named Drosophila, which the resolver already matches');
--   ELSIF NOT EXISTS (SELECT 1 FROM public.species WHERE lower(btrim(common_name)) = 'fruit fly' OR lower(btrim(name)) = 'fruit fly') THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, 'species_aliases', 'skipped', 'no Fruit Fly species row to resolve to');
--   ELSE
--     INSERT INTO public.species_aliases (alias, canonical, kind, common_name, note)
--     VALUES ('drosophila', 'Drosophila melanogaster', 'taxon_assumed', 'fruit fly',
--             'Genus name used for the laboratory fruit fly, e.g. JAABA''s species text "Drosophila (fruit flies)"; D. melanogaster assumed.')
--     ON CONFLICT (alias) DO NOTHING;
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, 'species_aliases', 'done', 'alias drosophila -> Drosophila melanogaster (taxon_assumed); takes effect once the exporter reads resources.metadata.species');
--   END IF;
-- END
-- $do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [datasets-O5] OPTIONAL: Credit PMID 39500574 (Cum et al. 2024) to R34DA059718
-- QUESTION FOR A CURATOR: Did R34DA059718 fund PMID 39500574? RePORTER, the system of record, does not credit it, and #444 recorded 'no NIH credit'.
-- -- "A Multiparadigm Approach to Characterize Dominance Behaviors in CD1 and C57BL6 Male Mice"
-- -- (Cum ... Padilla-Coreano, eNeuro 2024). For: public/bbqs_marr.yaml:291 lists it under
-- -- R34DA059718 from an earlier RePORTER pull; its last author is R34DA059718's contact PI; it shares
-- -- three author ORCIDs with 41093749, which R34DA059718 is credited with; first author Meghan Cum is a
-- -- consortium member. Against: the current RePORTER pull (import-grant-publications, the system of
-- -- record for this link, Principle III) no longer returns it for R34DA059718 or any BBQS grant, and
-- -- the #444 review recorded "Cum et al. 2024, no NIH credit". So the lab or a curator must say the
-- -- grant supported it. If it is out of scope instead, it should be deleted, not linked.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_datasets_o5() RETURNS void LANGUAGE plpgsql AS
-- $do$
-- DECLARE
--   _item constant text := 'credit PMID 39500574 to R34DA059718';
--   _pub  record;
--   _pid  uuid;
--   _have text;
-- BEGIN
--   PERFORM public.set_actor('migration:link_isolated_nodes');
--   PERFORM public.set_source_class('curator_fill');
--   SELECT id, resource_id, authors INTO _pub FROM public.publications WHERE pmid = '39500574';
--   IF NOT FOUND THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, '39500574', 'skipped', 'publication not found');
--     RETURN;
--   END IF;
--   IF _pub.resource_id IS DISTINCT FROM '36f00adf-1d84-4267-85c0-0af7379df8cc'::uuid THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, '39500574', 'report', format('spine row is %s, the 2026-11-04 export had 36f00adf-...', _pub.resource_id));
--   END IF;
--   SELECT id INTO _pid FROM public.projects WHERE grant_number = 'R34DA059718';
--   IF _pid IS NULL THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, '39500574', 'skipped', 'no R34DA059718 project row');
--     RETURN;
--   END IF;
--   SELECT string_agg(p.grant_number, ', ') INTO _have
--     FROM public.project_publications pp JOIN public.projects p ON p.id = pp.project_id
--    WHERE pp.publication_id = _pub.id;
--   IF _have IS NOT NULL THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, '39500574', CASE WHEN _have ~ 'R34DA059718' THEN 'noop' ELSE 'skipped' END, 'already credited to ' || _have);
--     RETURN;
--   END IF;
--   IF coalesce(_pub.authors, '') !~* 'padilla[- ]?coreano' THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, '39500574', 'skipped', 'author list no longer names Padilla-Coreano');
--     RETURN;
--   END IF;
--   -- constraint-agnostic, like import-grant-publications (index.ts:229-245)
--   INSERT INTO public.project_publications (project_id, publication_id)
--   SELECT _pid, _pub.id
--    WHERE NOT EXISTS (SELECT 1 FROM public.project_publications WHERE project_id = _pid AND publication_id = _pub.id);
--   INSERT INTO kg_fix_report (item, target, outcome, detail)
--   VALUES (_item, '39500574 -> R34DA059718', 'done', 'project_publications row added on a curator''s yes');
-- EXCEPTION WHEN OTHERS THEN
--   INSERT INTO kg_fix_report (item, target, outcome, detail) VALUES (_item, '39500574', 'error', SQLSTATE || ': ' || SQLERRM);
-- END
-- $do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [notices-06] OPTIONAL: The CIRTA announcement under MCGILL UNIVERSITY instead of BBQS Consortium
-- QUESTION FOR A CURATOR: Should the CIRTA announcement (its own text: 'McGill University is accepting nominations') move from the BBQS Consortium the 11-03 curator chose to McGill?
-- -- Its own text begins 'McGill University is accepting nominations for the Canada Impact+ Research
-- -- Training Awards', and both CIRTA job posts are already McGill's (part_of_org MCGILL UNIVERSITY).
-- -- The 11-03 curator edit put it under BBQS Consortium (#517 block 7: title 'Canada Impact+%'), so
-- -- this needs a curator's yes. It changes no isolated count: both organizations stay linked.
-- -- Moves both columns together (detail row, then spine row), and only from BBQS Consortium.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_notices_06() RETURNS void LANGUAGE plpgsql AS
-- $do$
-- DECLARE
--   _rid    constant uuid := '46841d0e-4d55-4690-81f0-41c33f424bc8';
--   _item   constant text := 'CIRTA announcement -> McGill (optional)';
--   _mcgill uuid := pg_temp.kg_org_of('c28b3fe8-8dbf-4037-ab56-fda6d170cfc4', 'MCGILL UNIVERSITY');
--   _bbqs   uuid := pg_temp.kg_org_of('766331fd-daea-4a31-86c4-589737e533ea', 'BBQS Consortium');
--   _n      int;
--   _m      int;
-- BEGIN
--   PERFORM public.set_actor('migration:link_isolated_nodes');
--   PERFORM public.set_source_class('curator_fill');
--   IF _mcgill IS NULL OR _bbqs IS NULL THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES (_item, 'Canada Impact+ Research Training Awards (CIRTA)', 'skipped', 'MCGILL UNIVERSITY or BBQS Consortium not found');
--     RETURN;
--   END IF;
--   UPDATE public.announcements SET organization_id = _mcgill, updated_at = now()
--    WHERE resource_id = _rid AND organization_id = _bbqs;
--   GET DIAGNOSTICS _n = ROW_COUNT;
--   UPDATE public.resources SET organization_id = _mcgill, updated_at = now()
--    WHERE id = _rid AND resource_type::text = 'announcement' AND organization_id = _bbqs;
--   GET DIAGNOSTICS _m = ROW_COUNT;
--   INSERT INTO kg_fix_report (item, target, outcome, detail)
--   VALUES (_item, 'Canada Impact+ Research Training Awards (CIRTA)', CASE WHEN _n + _m > 0 THEN 'done' ELSE 'noop' END,
--           format('moved to MCGILL UNIVERSITY: %s announcements row(s), %s spine row(s)', _n, _m));
-- EXCEPTION WHEN OTHERS THEN
--   INSERT INTO kg_fix_report (item, target, outcome, detail)
--   VALUES (_item, 'Canada Impact+ Research Training Awards (CIRTA)', 'error', SQLSTATE || ': ' || SQLERRM);
-- END
-- $do$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [tools-07] OPTIONAL: Organization links the repo does not state (VCL, Vocalocator, Vocalocator-SSL, SSL, senselab, OpenPose)
-- QUESTION FOR A CURATOR: Is each named organization the tool's maintainer (VCL Benchmark -> Simons Foundation or NYU; Vocalocator, Vocalocator-SSL, SSL -> NYU; senselab -> MIT; OpenPose -> CMU)? Keep only the confirmed lines.
-- -- Each needs a person's yes: the organization is implied by a URL host, a GitHub account or the
-- -- people behind a paper, not named in a statement about the resource. Uncomment a line only after
-- -- the project team or a curator confirms it. Same helper and guards as tools-02/03 (only where empty).
--
-- -- tools-07. VCL Benchmark -> Simons Foundation. Hosted at vclbenchmark.flatironinstitute.org (export);
-- -- the Flatiron Institute is the Simons Foundation's research division, which no repo file says.
-- -- The benchmark's producing grant, R34DA059513, is at NEW YORK UNIVERSITY (public/bbqs_marr.yaml:189),
-- -- so NYU (5b794afd-cf08-4107-81c8-522a29714830) is the other candidate. tools-05 already links it to its project.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_tools_07() RETURNS void LANGUAGE plpgsql AS
-- $blk$
-- BEGIN
--   PERFORM pg_temp.kg_tools_set_org('org: VCL Benchmark', '4921bfdf-7432-48ac-911d-0cb825184ef1', 'VCL Benchmark', 'benchmark',
--     '1a88610e-c3bc-41b8-a97e-36698d0b0c28', 'Simons Foundation',
--     (SELECT r.external_url ILIKE '%flatironinstitute.org%' FROM public.resources r WHERE r.id = '4921bfdf-7432-48ac-911d-0cb825184ef1'),
--     'hosted at vclbenchmark.flatironinstitute.org (Flatiron Institute = Simons Foundation); curator-confirmed');
--
--   -- tools-07. Vocalocator -> NEW YORK UNIVERSITY. github.com/neurostatslab/vocalocator; no repo file names
--   -- the lab. Its task matches the VCL paper's (R34DA059513, NYU; Alex Williams is co_pi there).
--   PERFORM pg_temp.kg_tools_set_org('org: Vocalocator', '515ee9e5-9453-4797-8017-f55c6dd7f1f7', 'Vocalocator', 'software',
--     '5b794afd-cf08-4107-81c8-522a29714830', 'NEW YORK UNIVERSITY', true,
--     'curator-confirmed: neurostatslab is the Williams lab (NYU)');
--
--   -- tools-07. Vocalocator-SSL -> NEW YORK UNIVERSITY. github.com/Aramist/vocalocator-ssl; Aramis Tanelus is
--   -- an author of R34DA059513's papers (public/bbqs_marr.yaml:197,205) but nothing ties the account to him.
--   PERFORM pg_temp.kg_tools_set_org('org: Vocalocator-SSL', '16b2b3ec-077a-4101-9a4a-0f85f06b984e', 'Vocalocator-SSL', 'software',
--     '5b794afd-cf08-4107-81c8-522a29714830', 'NEW YORK UNIVERSITY', true,
--     'curator-confirmed: Aramist = Aramis Tanelus (NYU, R34DA059513)');
--
--   -- tools-07. SSL (rodent USV detection & segmentation) -> NEW YORK UNIVERSITY. github.com/tianxiao18/ssl:
--   -- no repo or data tie at all; only grouped with the NYU audio tools by the diagnosis. Weakest of the set.
--   PERFORM pg_temp.kg_tools_set_org('org: SSL', '8c8402e7-5b64-4903-957e-8c7f3548512d', 'SSL (rodent USV detection & segmentation)', 'software',
--     '5b794afd-cf08-4107-81c8-522a29714830', 'NEW YORK UNIVERSITY', true,
--     'curator-confirmed: made by the Sanes/Schneider/Williams teams (NYU)');
--
--   -- tools-07. senselab -> MASSACHUSETTS INSTITUTE OF TECHNOLOGY. The row has no URL; senselab is the sensein
--   -- lab's package (Satrajit Ghosh, MIT; contact_pi of U24DA064429 BARD.CC), which no repo file says.
--   PERFORM pg_temp.kg_tools_set_org('org: senselab', 'c6be2ee8-73b8-412e-8331-4eac1f2937de', 'senselab', 'software',
--     '7924e7d9-5b53-4525-95ef-3f5a6b9112a5', 'MASSACHUSETTS INSTITUTE OF TECHNOLOGY', true,
--     'curator-confirmed: senselab is from the sensein lab (Ghosh, MIT)');
--
--   -- tools-07. OpenPose -> CARNEGIE-MELLON UNIVERSITY. Its repo is github.com/CMU-Perceptual-Computing-Lab/openpose
--   -- (export). Outside the listed scope: OpenPose is also linked by #512's uses_software once that merges.
--   PERFORM pg_temp.kg_tools_set_org('org: OpenPose', '529a7b7d-e25c-4d71-b61a-05733ab55f08', 'OpenPose', 'software',
--     'fb3cf5ef-e850-44d2-887c-0d0ef608f48c', 'CARNEGIE-MELLON UNIVERSITY',
--     (SELECT r.external_url ILIKE '%github.com/CMU-Perceptual-Computing-Lab/%' FROM public.resources r WHERE r.id = '529a7b7d-e25c-4d71-b61a-05733ab55f08'),
--     'repo github.com/CMU-Perceptual-Computing-Lab/openpose; curator-confirmed');
-- END
-- $blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [tools-08] OPTIONAL: resource_links the repo does not state (VCL evaluates Vocalocator; leaderboards evaluate DLC Model Zoo and pose tools)
-- QUESTION FOR A CURATOR: Does each benchmark evaluate the listed tool, and is the Animal Pose Leaderboard (paperswithcode.com) to be repointed or retired first? Keep only the confirmed lines.
-- -- Same helper and guards as tools-05; needs tools-04's table. Uncomment a call only after a curator confirms it.
--
-- -- tools-08. VCL Benchmark evaluates Vocalocator. Both rows describe rodent sound-source localization from
-- -- multi-channel audio, but no repo file or column says the benchmark scores this tool.
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_tools_08() RETURNS void LANGUAGE plpgsql AS
-- $blk$
-- BEGIN
--   PERFORM pg_temp.kg_tools_link('link', '4921bfdf-7432-48ac-911d-0cb825184ef1', 'VCL Benchmark', 'benchmark', 'evaluates',
--     '515ee9e5-9453-4797-8017-f55c6dd7f1f7', 'Vocalocator', 'software', 'curator_fill',
--     'curator-confirmed: the VCL paper (PMID 39345431) benchmarks Vocalocator', true);
--
--   -- tools-08. DLC Leaderboard evaluates DLC Model Zoo. The row says "DLC-based approaches" / "DLC variants";
--   -- whether the pre-trained zoo models are among them is not stated. This one would make CQ31 answer.
--   PERFORM pg_temp.kg_tools_link('link', 'b9f28848-dd76-4bf7-9fd6-a4d1509154eb', 'DLC Leaderboard', 'benchmark', 'evaluates',
--     'de29b286-d343-4108-90d9-3d11f8adc030', 'DLC Model Zoo', 'ml_model', 'curator_fill',
--     'curator-confirmed: the DLC Leaderboard ranks the model-zoo models', true);
--
--   -- tools-08. DLC Benchmarks evaluates DLC Model Zoo (the diagnosis's evaluated_by). Not stated anywhere.
--   PERFORM pg_temp.kg_tools_link('link', '858afe90-ab36-4d22-bfde-b4d7630a72ef', 'DLC Benchmarks', 'benchmark', 'evaluates',
--     'de29b286-d343-4108-90d9-3d11f8adc030', 'DLC Model Zoo', 'ml_model', 'curator_fill',
--     'curator-confirmed: benchmark.deeplabcut.org scores the model-zoo models', true);
--
--   -- TO2d-g. Animal Pose Leaderboard evaluates DeepLabCut, SLEAP, DeepPoseKit, Lightning Pose. The row says
--   -- only "Comparative ranking of pose estimation methods" and points at paperswithcode.com, which (to our
--   -- knowledge; not reachable from here) was shut down in July 2025. Decide first whether this node should
--   -- be repointed or retired; do not record what a dead page ranked. Lightning Pose is the surviving 3ba48c59.
--   PERFORM pg_temp.kg_tools_link('link', '83f2b36c-b0c8-4d4e-a1aa-08639a4068ae', 'Animal Pose Leaderboard', 'benchmark', 'evaluates',
--     '4009a1f6-c173-495b-9725-bb51571a3cdf', 'DeepLabCut', 'software', 'curator_fill', 'curator-confirmed: <source that lists DeepLabCut>', true);
--   PERFORM pg_temp.kg_tools_link('link', '83f2b36c-b0c8-4d4e-a1aa-08639a4068ae', 'Animal Pose Leaderboard', 'benchmark', 'evaluates',
--     '340ce805-e6f8-454a-bb4b-83ef53e0d444', 'SLEAP', 'software', 'curator_fill', 'curator-confirmed: <source that lists SLEAP>', true);
--   PERFORM pg_temp.kg_tools_link('link', '83f2b36c-b0c8-4d4e-a1aa-08639a4068ae', 'Animal Pose Leaderboard', 'benchmark', 'evaluates',
--     'c7d588c7-1778-4d8c-b7f6-03d8060463fb', 'DeepPoseKit', 'software', 'curator_fill', 'curator-confirmed: <source that lists DeepPoseKit>', true);
--   PERFORM pg_temp.kg_tools_link('link', '83f2b36c-b0c8-4d4e-a1aa-08639a4068ae', 'Animal Pose Leaderboard', 'benchmark', 'evaluates',
--     '3ba48c59-bb79-44ef-8569-ca644775d73a', 'Lightning Pose', 'software', 'curator_fill', 'curator-confirmed: <source that lists Lightning Pose>', true);
-- END
-- $blk$;

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- [tools-09] OPTIONAL: device_class_crosswalk plethysmography -> ppg
-- QUESTION FOR A CURATOR: Is every grant's 'plethysmography' evidence a pulse/PPG sensor, not whole-body plethysmography (breathing)? Run the SELECT in its comment first.
-- -- The old taxonomy calls the key "Plethysmography (PPG)" (src/pages/Devices.tsx:45), but in rodent
-- -- work "plethysmography" usually means whole-body plethysmography, which measures breathing
-- -- (respiration), not photoplethysmography. Run the SELECT first; uncomment the INSERT only if every
-- -- grant it lists records a pulse/PPG sensor.
-- --   SELECT e.seed_grant_number, e.depth, e.use_case, e.device_hardware
-- --     FROM public.grant_methods_evidence e WHERE 'plethysmography' = ANY (e.device_class);
-- CREATE OR REPLACE FUNCTION pg_temp.kg_o_tools_09() RETURNS void LANGUAGE plpgsql AS
-- $do$
-- DECLARE _n int;
-- BEGIN
--   PERFORM public.set_actor('migration:link_isolated_nodes');
--   PERFORM public.set_source_class('curator_fill');
--   IF NOT EXISTS (SELECT 1 FROM public.device_categories WHERE key = 'ppg')
--      OR EXISTS (SELECT 1 FROM public.device_class_crosswalk WHERE legacy_key = 'plethysmography' AND category_key <> 'ppg') THEN
--     INSERT INTO kg_fix_report (item, target, outcome, detail)
--     VALUES ('device crosswalk', 'plethysmography -> ppg', 'skipped', 'no ppg category, or plethysmography is already mapped elsewhere');
--     RETURN;
--   END IF;
--   INSERT INTO public.device_class_crosswalk (legacy_key, category_key) VALUES ('plethysmography', 'ppg')
--   ON CONFLICT (legacy_key, category_key) DO NOTHING;
--   GET DIAGNOSTICS _n = ROW_COUNT;
--   INSERT INTO kg_fix_report (item, target, outcome, detail)
--   VALUES ('device crosswalk', 'plethysmography -> ppg', CASE WHEN _n > 0 THEN 'done' ELSE 'noop' END,
--           'curator-confirmed: the grants'' plethysmography evidence is PPG');
-- END
-- $do$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. RUN. One DO block runs every block above in order, inside one savepoint:
--    * dry run ('on'): at the end the savepoint is rolled back (every write, the DDL included), and
--      the report rows are put back, so the editor still shows them;
--    * real run ('off'): committed below, unless any block reported an error: then NOTHING is
--      changed and the editor shows the errors.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $kg$
DECLARE
  kg_dry  constant boolean := coalesce(current_setting('bbqs.dry_run', true), 'on') IS DISTINCT FROM 'off';
  kg_keep pg_temp.kg_fix_report[];
  kg_errs int := 0;
  kg_list text;
BEGIN
  BEGIN
    PERFORM pg_temp.kg_run(1, 'datasets-D00', 'Pre-flight (read-only): which ember-dandiset-sync is live', 'pg_temp.kg_b_datasets_d00');
    PERFORM pg_temp.kg_run(2, 'people-01', 'Delete the 14 orphan investigator spine rows', 'pg_temp.kg_b_people_01');
    PERFORM pg_temp.kg_run(3, 'people-02', 'Delete the ''TestUser Tier2'' test record', 'pg_temp.kg_b_people_02');
    PERFORM pg_temp.kg_run(4, 'people-03', 'Merge ''Niegil Francis Muttath Joseph'' (83e96042) into ''Niegil Francis'' (af80d437)', 'pg_temp.kg_b_people_03');
    PERFORM pg_temp.kg_run(5, 'tools-01', 'Fold the duplicate Lightning Pose spine row 444f664a into 3ba48c59', 'pg_temp.kg_b_tools_01');
    PERFORM pg_temp.kg_run(6, 'notices-03', 'Merge the superseded forecast RFA-NS-26-011 into RFA-NS-27-002', 'pg_temp.kg_b_notices_03');
    PERFORM pg_temp.kg_run(7, 'datasets-D01', 'Apply 20261105120000 (dandisets.hidden*, CHECK, set_dandiset_hidden) where missing', 'pg_temp.kg_b_datasets_d01');
    PERFORM pg_temp.kg_run(8, 'datasets-D02', 'Hide the 28 IDP/ARC integration-test uploads (#506)', 'pg_temp.kg_b_datasets_d02');
    PERFORM pg_temp.kg_run(9, 'datasets-D03', 'Hide the four test uploads 000001, 000003, 000431, 000467 (#506)', 'pg_temp.kg_b_datasets_d03');
    PERFORM pg_temp.kg_run(10, 'datasets-D04', 'Hide ''Single Click Science'' (000468): synthetic mock data, #444 Exclude', 'pg_temp.kg_b_datasets_d04');
    PERFORM pg_temp.kg_run(11, 'datasets-D05', '''Pozu: Missing subjects'' (000472): hide if it has 0 files, else link it to R24MH136632', 'pg_temp.kg_b_datasets_d05');
    PERFORM pg_temp.kg_run(12, 'datasets-D09', 'Merge species ''Acoel Flatworm'' (10ceb449) into Hofstenia miamia (d6fbdcc7)', 'pg_temp.kg_b_datasets_d09');
    PERFORM pg_temp.kg_run(13, 'people-06', 'Create ''University College London'' and ''University of Washington'' (only if people-08 can link someone)', 'pg_temp.kg_b_people_06');
    PERFORM pg_temp.kg_run(14, 'people-05', 'Affiliate the 11 NIH program staff with their institute (or NIH)', 'pg_temp.kg_b_people_05');
    PERFORM pg_temp.kg_run(15, 'people-07', 'Affiliate 16 members with the existing organization node their institution names', 'pg_temp.kg_b_people_07');
    PERFORM pg_temp.kg_run(16, 'people-08', 'Affiliate 3 members with the organizations people-06 creates', 'pg_temp.kg_b_people_08');
    PERFORM pg_temp.kg_run(17, 'people-10', 'Both Walker records side by side (read-only; the merge itself is optional)', 'pg_temp.kg_b_people_10_report');
    PERFORM pg_temp.kg_run(18, 'notices-01', 'Copy announcements'' (and jobs'') organization onto their spine rows', 'pg_temp.kg_b_notices_01');
    PERFORM pg_temp.kg_run(19, 'notices-02', 'Event ''BBQS MIT Workshop 2026'' -> BBQS Consortium', 'pg_temp.kg_b_notices_02');
    PERFORM pg_temp.kg_run(20, 'notices-04', 'Each funding call''s issuer, from its own FON -> resources.organization_id', 'pg_temp.kg_b_notices_04');
    PERFORM pg_temp.kg_run(21, 'tools-02', 'Lightning Pose (3ba48c59) -> COLUMBIA UNIVERSITY HEALTH SCIENCES', 'pg_temp.kg_b_tools_02');
    PERFORM pg_temp.kg_run(22, 'tools-03', 'Psych-DS -> MASSACHUSETTS INSTITUTE OF TECHNOLOGY', 'pg_temp.kg_b_tools_03');
    PERFORM pg_temp.kg_run(23, 'datasets-D06', 'Link the EMBER collections 000469, 000470, 000471, 000474 to R24MH136632 (roster evidence)', 'pg_temp.kg_b_datasets_d06');
    PERFORM pg_temp.kg_run(24, 'datasets-D07', 'Link ''Four-choice reversal digging task'' (000607) to R34DA062119', 'pg_temp.kg_b_datasets_d07');
    PERFORM pg_temp.kg_run(25, 'datasets-D08', 'Link datasets whose own DANDI record names a BBQS award the sync''s parser dropped', 'pg_temp.kg_b_datasets_d08');
    PERFORM pg_temp.kg_run(26, 'tools-04', 'Create public.resource_links (audited, anon-readable, typed by LinkML slot)', 'pg_temp.kg_b_tools_04');
    PERFORM pg_temp.kg_run(27, 'tools-05', 'Record the five evidenced links in resource_links', 'pg_temp.kg_b_tools_05');
    PERFORM pg_temp.kg_run(28, 'tools-06', 'device_class_crosswalk rows for the isolated device categories', 'pg_temp.kg_b_tools_06');
    -- optional blocks: run only if uncommented in section 3
    PERFORM pg_temp.kg_run_optional(29, 'people-04', 'Give the merged Niegil record the fuller name on both rows', 'pg_temp.kg_o_people_04',
      'Should the merged record be named ''Niegil Francis Muttath Joseph'' on both rows? (publications credit him as ''Francis, Niegil'')');
    PERFORM pg_temp.kg_run_optional(30, 'people-09', 'Second affiliation for Jongwoon Kim: COLUMBIA UNIVERSITY HEALTH SCIENCES', 'pg_temp.kg_o_people_09',
      'Is Jongwoon Kim at NYU Langone, Columbia, or both today?');
    PERFORM pg_temp.kg_run_optional(31, 'people-10-merge', 'Merge ''Jeffrey Walker'' (e1424ffb) into ''Jeffery Walker'' (7a5a1c11) and take the spelling ''Jeffrey''', 'pg_temp.kg_o_people_10',
      'Are ''Jeffrey Walker'' (e1424ffb) and ''Jeffery Walker'' (7a5a1c11, Yale) one person? 20260826120000 judged them two people at two institutions; the people-10 report rows show both records.');
    PERFORM pg_temp.kg_run_optional(32, 'datasets-O1', 'Hide 000598 ''EMBER Bees DeepLabCut Training — Workflow Smoke Test'' (linked, not isolated)', 'pg_temp.kg_o_datasets_o1',
      'Hide the smoke test #506 lists, although a curator linked it to EMBER on 2026-11-03 (#517 block 10)? It removes a linked node and fixes no isolated one.');
    PERFORM pg_temp.kg_run_optional(33, 'datasets-O2a', 'Link the SLEAP re-hosts 000265 and 000398 to R24MH136632 (or hide them)', 'pg_temp.kg_o_datasets_o2a',
      'Are 000265 and 000398 (public sleap.ai data re-hosted on EMBER-DANDI) EMBER demos to credit to R24MH136632, or copies to hide (the two commented kg_ds_hide lines inside)?');
    PERFORM pg_temp.kg_run_optional(34, 'datasets-O2b', 'Link whichever EMBER collections D05/D06 skipped for want of roster evidence', 'pg_temp.kg_o_datasets_o2b',
      'Does EMBER confirm that each collection datasets-D05/D06 skipped (see their report rows) is its own? Keep only those lines.');
    PERFORM pg_temp.kg_run_optional(35, 'datasets-O3', 'Confirm species candidate Cricket for R34DA059512 (append) + alias cricket -> Gryllidae', 'pg_temp.kg_o_datasets_o3',
      'Does R34DA059512 study the cricket (its prey) as a species? On 2026-11-03 the curator set [''Mus musculus''] only.');
    PERFORM pg_temp.kg_run_optional(36, 'datasets-O4', 'Alias ''drosophila'' -> Drosophila melanogaster (Fruit Fly) for JAABA', 'pg_temp.kg_o_datasets_o4',
      'Is a ''drosophila'' -> Drosophila melanogaster alias wanted? (Probably a no-op: the Fruit Fly row is named ''Drosophila''.)');
    PERFORM pg_temp.kg_run_optional(37, 'datasets-O5', 'Credit PMID 39500574 (Cum et al. 2024) to R34DA059718', 'pg_temp.kg_o_datasets_o5',
      'Did R34DA059718 fund PMID 39500574? RePORTER, the system of record, does not credit it, and #444 recorded ''no NIH credit''.');
    PERFORM pg_temp.kg_run_optional(38, 'notices-06', 'The CIRTA announcement under MCGILL UNIVERSITY instead of BBQS Consortium', 'pg_temp.kg_o_notices_06',
      'Should the CIRTA announcement (its own text: ''McGill University is accepting nominations'') move from the BBQS Consortium the 11-03 curator chose to McGill?');
    PERFORM pg_temp.kg_run_optional(39, 'tools-07', 'Organization links the repo does not state (VCL, Vocalocator, Vocalocator-SSL, SSL, senselab, OpenPose)', 'pg_temp.kg_o_tools_07',
      'Is each named organization the tool''s maintainer (VCL Benchmark -> Simons Foundation or NYU; Vocalocator, Vocalocator-SSL, SSL -> NYU; senselab -> MIT; OpenPose -> CMU)? Keep only the confirmed lines.');
    PERFORM pg_temp.kg_run_optional(40, 'tools-08', 'resource_links the repo does not state (VCL evaluates Vocalocator; leaderboards evaluate DLC Model Zoo and pose tools)', 'pg_temp.kg_o_tools_08',
      'Does each benchmark evaluate the listed tool, and is the Animal Pose Leaderboard (paperswithcode.com) to be repointed or retired first? Keep only the confirmed lines.');
    PERFORM pg_temp.kg_run_optional(41, 'tools-09', 'device_class_crosswalk plethysmography -> ppg', 'pg_temp.kg_o_tools_09',
      'Is every grant''s ''plethysmography'' evidence a pulse/PPG sensor, not whole-body plethysmography (breathing)? Run the SELECT in its comment first.');
    -- read-only reports, last, so they describe the end state
    PERFORM pg_temp.kg_run(42, 'people-01-report', 'Remaining orphan spine rows, and person rows with no spine row (read-only)', 'pg_temp.kg_b_people_01_report');
    PERFORM pg_temp.kg_run(43, 'people-11', 'The 4 name-only records: what their own rows hold (read-only; not fixable by SQL)', 'pg_temp.kg_b_people_11');
    PERFORM pg_temp.kg_run(44, 'datasets-D10', 'Datasets still unlinked, with their DANDI contact; stale spine names (read-only)', 'pg_temp.kg_b_datasets_d10');
    PERFORM pg_temp.kg_run(45, 'notices-05', 'Participating-only funder organizations: edges today, funding_opportunity_orgs rows (read-only)', 'pg_temp.kg_b_notices_05');
    PERFORM pg_temp.kg_run(46, 'tools-10', 'Device-category reach, unmapped buckets, tool nodes still unlinked (read-only)', 'pg_temp.kg_b_tools_10');

    SELECT count(*) INTO kg_errs FROM pg_temp.kg_fix_report WHERE kind = 'decision' AND outcome = 'error';
    IF kg_dry OR kg_errs > 0 THEN
      SELECT array_agg(r ORDER BY r.seq) INTO kg_keep FROM pg_temp.kg_fix_report r;
      RAISE EXCEPTION USING ERRCODE = 'KG000', MESSAGE = 'link_isolated_nodes: rolling the run back';
    END IF;
  EXCEPTION WHEN SQLSTATE 'KG000' THEN
    -- Every write above is undone at this point; only the report survives (it was copied first).
    INSERT INTO pg_temp.kg_fix_report SELECT * FROM unnest(kg_keep);
  END;
  PERFORM public.set_actor('migration:link_isolated_nodes');
  IF NOT kg_dry AND kg_errs > 0 THEN
    SELECT string_agg(format('[%s] %s · %s · %s', r.block, r.item, coalesce(r.target, ''), r.detail), E'\n' ORDER BY r.seq)
      INTO kg_list FROM pg_temp.kg_fix_report r WHERE r.kind = 'decision' AND r.outcome = 'error';
    RAISE EXCEPTION E'link_isolated_nodes: NOTHING WAS CHANGED, % error(s):\n%', kg_errs, kg_list
      USING HINT = 'Set the dry-run switch back to ''on'' and run again to see the whole report; fix the cause, or comment out that block''s line in section 4.';
  END IF;
  PERFORM pg_temp.kg_result(kg_dry);
END
$kg$;

COMMIT;

-- The report (the editor shows only this last result): RESULT, then one summary row per block
-- (rows = rows written), then every decision. In a dry run it shows what WOULD be written.
SELECT * FROM pg_temp.kg_report();
