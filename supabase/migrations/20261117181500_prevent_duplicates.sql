-- ================================================================================================
-- 20261117181500_prevent_duplicates.sql
-- Refuse a duplicate when it is written: one rule per identity key, a unique index on each key,
-- one detail row per KG node, and each preprint LINKED to its published version, never merged.
-- ================================================================================================
--
-- WHAT AND WHY
--   "If you have something in the KG already, you don't want to duplicate it; cleaning is a
--   difficult and tedious task as the KG grows; link, don't copy; make a decision and stick to it"
--   (Tek, reviewing the KG). Until now a duplicate was only DETECTED (kg/quality.py duplicates(), a
--   CI gate against kg/quality_baseline.json) and CLEANED by hand (20261116150000 merged the 14
--   groups of the 2026-11-04 export). Nothing PREVENTED the next one: the database had unique keys
--   on funding_opportunities.fon, dandisets (instance, dandiset_id) and investigators' e-mail only.
--   This script makes the database refuse it:
--   * keys-01, keys-02. One SQL function per identity key, public.kg_<key>_key(text), and the
--     pairing rule's three parts. The same rule is written in TypeScript
--     (supabase/functions/_shared/identity-keys.ts, the write paths) and Python
--     (kg/identity_keys.py, the export gate); kg/identity_keys.json states each rule once, with
--     the vectors that hold the three implementations equal. keys-02 runs the 97 SQL vectors HERE,
--     on this database, before any index is built on a function: a mismatch is an error row, and
--     the run changes nothing.
--   * index-01 to index-07. A unique index on each key. A value with no key (empty, or not an
--     ORCID iD, DOI or PMID at all) is never enforced. An index is created only if the live rows
--     already satisfy it. Where they do not, it is SKIPPED and every group of rows that share a key
--     is listed with what references each row: a curator merges each group (or corrects a value
--     that is wrong on one of its rows), then runs this script again, which creates what it skipped
--     and changes nothing else. A URL is no key: a notice URL can be a landing page (an NIH
--     highlighted-topic page) that lists several calls, so two calls may share one.
--   * nodes-01. One detail row per KG node: a unique index on resource_id in each of the 13 node
--     tables. Two rows that point at one spine row are folded into one node by the exporter,
--     silently; now the database refuses the second row (catalogue invariant #2).
--   * links-01, links-02, versions-01, versions-02. A preprint and its published paper are two
--     records of one work. They are LINKED, never merged (a merge loses the preprint's own PMID,
--     DOI and date): resource_links (published, 'revision_of', preprint), the LinkML slot
--     revision_of (prov:wasRevisionOf: the newer revises the older). The pairing rule is stated
--     once, in public.kg_link_publication_versions(): it never links a "preprint" that is later
--     than the paper (by year, else by PubMed id: kg_preprint_is_later), and it tells a bioRxiv or
--     medRxiv DOI by its shape, not by the 10.1101/ prefix Cold Spring Harbor's journals share.
--     versions-01 uses it to link the 5 pairs of the 2026-11-17 export that a curator read, and
--     only them; import-grant-publications uses it for the papers it imports.
--   * orphans-01 (read-only) lists what still keeps a person or an organization from being one node.
--   Nothing is rewritten: a key is computed from the stored value, so curated spellings (eLife's
--   DOI case, RePORTER's capitals) stay as they are. Every write is audited as
--   'migration:prevent_duplicates' (Principle X). The rules and their vectors: kg/identity_keys.json;
--   the model: kg/README.md, "Modelling rule: link, don't copy". It came with issue #521, whose own
--   subject (classifying funding calls) it does not touch; it makes the rule notices-03 applied
--   there (a final notice supersedes its forecast in place, one row per call) the standing one.
--
-- THE KEYS. Whitespace and case are ASCII only (COLLATE "C"), names are compared after Unicode
-- NFKD; kg/identity_keys.json states each rule. Every index is partial: WHERE <key> IS NOT NULL.
--   index                               table and key
--   uq_investigators_orcid_key          investigators (kg_orcid_key(orcid))       0000-0002-1825-009X
--   uq_publications_doi_key             publications (kg_doi_key(doi))            10.7554/elife.89892
--   uq_publications_pmid_key            publications (kg_pmid_key(pmid))          41331138 (no zeros)
--   uq_organizations_name_key           organizations (kg_name_key(name))         universityofcaliforniasandiego
--   uq_grants_award_key                 grants (kg_award_key(grant_number))       R34DA059513 (the NIH core)
--   uq_projects_award_key               projects (kg_award_key(grant_number))     R34DA059513
--   uq_funding_opportunities_fon_key    funding_opportunities (kg_fon_key(fon))   RFANS27002
--   uq_<table>_resource_id              <table> (resource_id), for investigators, organizations,
--                                       grants, publications, software_tools, funding_opportunities,
--                                       dandisets, species, device_models, device_manufacturers,
--                                       device_categories, jobs and announcements
--   The exact keys stay as they are (funding_opportunities_fon_key, grants_grant_number_key,
--   investigators_name_key, investigators_email_unique_ci). No key on a person's name (namesakes
--   exist), none on a URL (a landing page can serve many records: kg/quality.py compares URLs as a
--   signal only), and none on tool-like resources (no one rule fits every type; add_resource matches
--   per type and the export gate checks). A curated value may stay non-canonical: the key folds it.
--   The organization name key folds case, punctuation, spacing and accents (Greek letters by name),
--   never wording: 'STATE UNIVERSITY NEW YORK STONY BROOK' and 'State University of New York at
--   Stony Brook', two nodes of one institution in the 2026-11-17 export, are two keys, so index-04
--   does not see them. They are a known duplicate for a curator to merge; ROR is the identity that
--   would see it (organizations has no ROR column yet).
--
-- HOW TO APPLY: Supabase SQL editor, project vpexxhfpvghlejljwpvt, as its default role (postgres).
--   Copy it with:  Get-Content "<checkout>\supabase\migrations\20261117181500_prevent_duplicates.sql" -Raw | Set-Clipboard
--   (the file is ASCII only, so no code page can garble it), paste the WHOLE file, then Run.
--   1. As shipped it is a DRY RUN: every block runs, the report is shown, then everything is rolled
--      back. The editor may warn about DROP statements; in a dry run nothing is kept.
--   2. Read the report (the script's last statement, the only result the editor shows): the RESULT
--      row, one row per block (rows = rows written), then each decision. A 'skipped' row under
--      index-0x or nodes-01 is a group of rows that share a key; its index is not created until a
--      curator merges the group. If any row says 'error', a real run would change nothing.
--   3. Apply: in the DRY-RUN SWITCH line just below BEGIN, change 'on' to 'off' (the only edit), and
--      Run the whole file again. It is one transaction: an unexpected error rolls ALL of it back,
--      and the editor then shows the list of errors instead of the report.
--   4. A second run changes nothing and reports 0 rows. After a curator has merged a skipped group,
--      run the script again (dry run first): it creates the indexes it skipped.
--   LOCKS. The dry run takes the same locks as the real run, for as long (seconds). Writes wait on
--   each table an index is being built on (SHARE: investigators, publications, organizations,
--   grants, projects, funding_opportunities and the 13 node tables, only while an index is still
--   missing). While its CHECK is replaced (the first run only), every read and write waits on
--   resource_links (ACCESS EXCLUSIVE). No wait lasts more than 5 s (lock_timeout, set right after
--   BEGIN): a block that would wait longer reports an error row (55P03), and the run changes
--   nothing. Run it again when the site is quiet. A second run takes no lock beyond plain reads.
--
-- PRECONDITIONS
--   * 20261116150000_link_isolated_nodes.sql is applied (production has it): its block tools-04
--     created public.resource_links. Without it, links-01 to versions-02 report 'skipped' and
--     change nothing, while the keys and indexes are still created; run this script again after it.
--   * Every write path that meets these indexes. Once an index exists, a write that would give a
--     second row the same key fails with 23505 (unique_violation) naming the index; nothing is
--     merged silently, but a caller that does not expect 23505 shows it raw. They are:
--       - the six edge functions: import-grant-publications, bbqs-mcp (add_resource,
--         add_funding_opportunity, create_grant, repoint_grant, refresh_grant_from_reporter),
--         nih-grants, add-project-by-grant, seed-consortium, verify-affiliations. Deploy them
--         first: they look up by these keys before they write and report a 23505 as "already in
--         the KG";
--       - public.member_self_update(), from src/components/profile/MemberProfileEditor.tsx and the
--         MCP tool update_my_profile: an ORCID iD another record holds (an email-less twin) refuses
--         the WHOLE profile save on uq_investigators_orcid_key, and the editor shows the raw error;
--       - src/components/funding/AddFundingOpportunityDialog.tsx: a FON spelled another way than
--         an existing call's (uq_funding_opportunities_fon_key). It has no supersede path: a final
--         notice that reuses its forecast's FON is a curator's merge (bbqs-mcp supersedes);
--       - src/pages/Publications.tsx (a paper added by hand): a DOI or PMID another row holds in
--         another spelling (uq_publications_doi_key, uq_publications_pmid_key);
--       - the RPCs public.create_grant() and public.repoint_grant(), from any caller besides the
--         MCP (create_grant strips only a '-NN' suffix and matches its institution with
--         lower(btrim)): a per-year or leading-digit number of an existing award
--         (uq_grants_award_key, uq_projects_award_key), an institution spelled another way
--         (uq_organizations_name_key);
--       - ../bbqs-agent, the chat agent, which shares this database: check it for direct writes
--         to the keyed columns (investigators.orcid, publications.doi and pmid, organizations.name,
--         grants.grant_number, projects.grant_number, funding_opportunities.fon, and resource_id on
--         the 13 node tables) BEFORE the real run. It is not in this repository, so it was not.
--   * The server encoding is UTF8 (it is on Supabase): kg_name_key uses normalize(..., NFKD).
--
-- VERIFY
--   * RESULT says APPLIED, no row says error, and a second run reports 0 rows.
--   * SELECT indexrelid::regclass AS index, pg_get_indexdef(indexrelid) FROM pg_index
--      WHERE indexrelid::regclass::text LIKE 'uq\_%' ORDER BY 1;   -- the 7 keys and 13 resource_id
--     indexes, next to the older uq_investigators_reporter_profile_id
--   * SELECT count(*) FROM public.resource_links WHERE predicate = 'revision_of';   -- 5
--   * SELECT table_name, operation, count(*) FROM public.data_audit_log
--      WHERE actor_label = 'migration:prevent_duplicates' GROUP BY 1, 2;   -- resource_links INSERT 5
--   * Re-export the graph (kg/export.py) and run kg/quality.py: the 5 preprint/published pairs are
--     "linked_versions", no longer "versions" (pairs to link).
--
-- UNDO (as one transaction, after SELECT public.set_actor('migration:undo_prevent_duplicates');)
--   * DROP INDEX each uq_* index this script created (the report's done rows name them);
--   * DELETE FROM public.resource_links WHERE predicate = 'revision_of'; (their rows are in
--     data_audit_log, new_data, under actor_label 'migration:prevent_duplicates');
--   * restore resource_links_predicate_check and resource_links_check_types() as 20261116150000
--     tools-04 created them (that block's text: 4 predicates, produced accepting a publication);
--   * DROP FUNCTION public.kg_link_publication_versions(uuid[], text, boolean, boolean), then the
--     nine public.kg_* functions (only after their indexes are gone).
--   Not restorable from data_audit_log: the DDL above (no audit trigger records it).
--
-- THE BLOCKS, in run order. Every block re-reads the live catalog and rows, and reports each
-- decision (done / noop / skipped / report / error).
--   keys-01      create the 9 functions (6 identity keys; the pairing rule's kg_title_key,
--                kg_is_preprint and kg_preprint_is_later) where missing. One that exists with
--                another definition is an ERROR, never replaced: CREATE OR REPLACE changes an
--                indexed function without a word, and every index on it would keep the old keys.
--   keys-02      the self-test: this database computes kg/identity_keys.json's 97 SQL vectors
--   index-01..07 one unique index per key (table above); a colliding group skips its index only
--   nodes-01     uq_<table>_resource_id on the 13 node tables (one decision per table)
--   links-01     resource_links accepts revision_of (a publication to a publication, never both
--                ways); produced no longer accepts a publication (a project's papers are
--                project_publications rows: one fact, one store). If a produced -> publication link
--                exists, produced keeps accepting a publication and the link is listed.
--   links-02     create public.kg_link_publication_versions() (service_role only), the pairing rule
--   versions-01  link the 5 pairs of the 2026-11-17 export with it (basis curator_fill), and only
--                them: another pair the rule finds in their title groups is listed, not linked:
--                  42131509 -> 41040807  BRAID               R61MH135407
--                  41331138 -> 37425712  CaBLAM              R34DA059500
--                  42516064 -> 41292955  CapuchinAI          R34DA061925
--                  41321375 -> 41040797  Dynamical Modeling  R61MH135407
--                  39680425 -> 39282260  gerbil vocal usage  R34DA059513
--   Read-only, they write nothing: versions-02 (any other pair the rule finds, and how to link it),
--   orphans-01 (investigator spine rows no person points at, people with no node, name drift,
--   orphan spine rows per type).
--
-- EFFECT, as the 2026-11-17 export shows the data (tested on a replica of the schema holding a
-- synthetic copy of the exported rows, with 20261116150000 applied): no key collides, so all 7 key
-- indexes and the 13 resource_id indexes are created, and the 5 pairs are linked: 5 rows written.
-- Rows the export does not show (people with no node, hidden datasets, publications with no node)
-- can still collide here; each such group is listed, and only its index waits. Not seen by any
-- index: the Stony Brook pair of organization nodes above (other wording), to merge by hand.
--
-- NOT DONE HERE (who)
--   * Orphan investigator spine rows (a person deleted, the spine row left; or the spine row written
--     and the person insert failed): no database rule this round. The write paths now insert the
--     person first (kg-write.ts), and orphans-01 lists what is left (a developer, then a curator).
--   * A key on a person's name, and on tool-like resources (see above).
-- ================================================================================================

BEGIN;
-- No lock wait longer than 5 s, in the dry run as in the real run (both take the same locks). A
-- block that waits longer gets 55P03, reports it as an error row, and the run then changes nothing.
SET LOCAL lock_timeout = '5s';
-- Principle X: a SQL-editor write has no auth.uid(), so the script names itself before any write.
-- Both settings are transaction-local; the runner re-declares them before every block.
SELECT public.set_actor('migration:prevent_duplicates');
SELECT public.set_source_class('curator_fill');

-- +------------------------------ DRY-RUN SWITCH (the one line to edit) ------------------------------+
--   'on'  = rehearse: run every block, show the report, then roll everything back (nothing changes).
--   'off' = apply: the same run, committed.  Any other value is treated as 'on'.
SELECT set_config('bbqs.dry_run', 'on', true);
-- +----------------------------------------------------------------------------------------------------+

-- ================================================================================================
-- 0. SETUP: the report table and the runner. Temp objects only (schema pg_temp): nothing in this
--    section writes to a real table. Dropped first, so a second run in the same editor session
--    starts from a clean report.
-- ================================================================================================
-- Every pg_temp.kg_* function an earlier run left in this editor session goes first, whatever its
-- arguments: CREATE OR REPLACE keeps an old overload whose arguments differ, and two overloads make
-- a call ambiguous (42725).
DO $drop$
DECLARE _f text;
BEGIN
  FOR _f IN
    SELECT format('pg_temp.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p
     WHERE p.pronamespace = pg_my_temp_schema() AND p.proname LIKE 'kg\_%'
  LOOP
    EXECUTE 'DROP FUNCTION ' || _f;
  END LOOP;
END
$drop$;
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
  outcome text NOT NULL CHECK (outcome IN ('done', 'noop', 'skipped', 'report', 'error')),
  n_rows  bigint,
  detail  text
);

-- Run one block: name it, re-declare the actor (Principle X), run it in its own savepoint, then
-- write its summary row. The row count is read back from the audit trail itself: every
-- data_audit_log row this transaction wrote since the block began (occurred_at = now() is this
-- transaction's start time). DDL (a function, an index, a constraint) writes no audit row: a
-- block's done rows name what it created. An error inside a block is caught here, the block's own
-- writes are rolled back to its savepoint, and an 'error' row is written: the runner then rolls the
-- WHOLE script back (a real run never commits a partial result).
CREATE OR REPLACE FUNCTION pg_temp.kg_run(_ord int, _block text, _title text, _fn text)
RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  _a0 bigint; _p0 bigint; _q0 bigint; _np bigint; _nw bigint;
  _writes text; _other text; _outs text; _agg text;
  _st text; _msg text; _ctx text;
BEGIN
  PERFORM set_config('bbqs.block', _block, true);
  PERFORM set_config('bbqs.block_ord', _ord::text, true);
  PERFORM public.set_actor('migration:prevent_duplicates');
  PERFORM public.set_source_class('curator_fill');
  SELECT coalesce(max(id), 0) INTO _a0 FROM public.data_audit_log;
  SELECT coalesce(max(id), 0) INTO _p0 FROM public.field_provenance;
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
  PERFORM public.set_actor('migration:prevent_duplicates');
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
     AND d.actor_label IS DISTINCT FROM 'migration:prevent_duplicates';
  SELECT count(*) INTO _np FROM public.field_provenance WHERE id > _p0;

  SELECT string_agg(format('%s %s', o.outcome, o.n), ', ' ORDER BY o.pos),
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
  VALUES ('summary', _title || ' [' || coalesce(_outs, 'no decisions') || ']', coalesce(_agg, 'report'), _nw,
          format('audited writes: %s; field_provenance claims recorded: %s%s', _writes, _np,
                 CASE WHEN _other IS NOT NULL THEN '; WARNING: audit rows labelled ' || _other ELSE '' END));
END
$fn$;

-- The RESULT row: what happened, totals, what is left to a curator, and how to flip the switch.
CREATE OR REPLACE FUNCTION pg_temp.kg_result(_dry boolean)
RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  _sw   text := coalesce(current_setting('bbqs.dry_run', true), '(unset)');
  _tot  bigint;
  _dec  text;
  _blk  int;
  _err  int;
  _skip text;
BEGIN
  SELECT coalesce(sum(n_rows), 0), count(*) INTO _tot, _blk FROM pg_temp.kg_fix_report WHERE kind = 'summary';
  SELECT string_agg(format('%s %s', o.outcome, o.n), ', ' ORDER BY o.pos), coalesce(sum(o.n) FILTER (WHERE o.outcome = 'error'), 0)
    INTO _dec, _err
    FROM (SELECT outcome, count(*) AS n,
                 array_position(ARRAY['done', 'noop', 'skipped', 'report', 'error'], outcome) AS pos
            FROM pg_temp.kg_fix_report WHERE kind = 'decision' GROUP BY outcome) o;
  -- The unique indexes a colliding group kept from being created (each group is one skipped row).
  SELECT string_agg(DISTINCT split_part(target, ':', 1), ', ') INTO _skip
    FROM pg_temp.kg_fix_report
   WHERE kind = 'decision' AND outcome = 'skipped' AND item = 'unique key' AND target LIKE '%:%';
  PERFORM set_config('bbqs.block', 'RESULT', true);
  PERFORM set_config('bbqs.block_ord', '0', true);
  INSERT INTO pg_temp.kg_fix_report (kind, item, outcome, n_rows, detail)
  VALUES ('result',
          CASE WHEN _dry THEN 'DRY RUN: every block ran, then everything was rolled back. NOTHING WAS CHANGED.'
               ELSE 'APPLIED: committed as one transaction under migration:prevent_duplicates.' END,
          CASE WHEN _err > 0 THEN 'error' WHEN _dry THEN 'report' ELSE 'done' END,
          _tot,
          format('%s block(s) ran; decisions: %s; rows%s written: %s (summary rows below; DDL writes no row, the done rows name it). ',
                 _blk, coalesce(_dec, 'none'), CASE WHEN _dry THEN ' that WOULD be' ELSE '' END, _tot)
          || CASE WHEN _skip IS NOT NULL
                  THEN format('NOT CREATED, rows share a key: %s. A curator merges each group listed (skipped rows) or corrects its wrong value, then runs this script again. ', _skip)
                  ELSE '' END
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
              THEN r.outcome || ' | ' || r.item || coalesce(' | ' || r.target, '')
              ELSE r.item END,
         r.n_rows,
         r.detail
    FROM pg_temp.kg_fix_report r
   ORDER BY CASE r.kind WHEN 'result' THEN 0 WHEN 'summary' THEN 1 ELSE 2 END, r.ord, r.seq
$fn$;

-- ================================================================================================
-- 1. DEFINITIONS AND HELPERS (pg_temp, gone at the end of the session). The public objects this
--    script creates are written out here, once, as the statements that create them.
-- ================================================================================================

-- A function body as written between its $fn$ quotes, from one of the statements below.
CREATE OR REPLACE FUNCTION pg_temp.kg_fn_body(_ddl text) RETURNS text
LANGUAGE sql IMMUTABLE AS
$q$ SELECT substring(_ddl FROM '\$fn\$(.*)\$fn\$') $q$;

-- Source text with every run of whitespace folded to one space: compares a function body that
-- another file created with other indentation and line ends.
CREATE OR REPLACE FUNCTION pg_temp.kg_norm_src(_s text) RETURNS text
LANGUAGE sql IMMUTABLE AS
$q$ SELECT btrim(regexp_replace(coalesce(_s, ''), '\s+', ' ', 'g')) $q$;

-- THE IDENTITY KEYS, as kg/identity_keys.json states each rule (TypeScript: _shared/identity-keys.ts,
-- Python: kg/identity_keys.py; the vectors in keys-02 hold them equal). Every function is IMMUTABLE
-- PARALLEL SAFE with search_path pg_catalog (STRICT, but for kg_is_preprint and
-- kg_preprint_is_later, which read a NULL argument), and folds case and whitespace in ASCII only
-- (COLLATE "C"), whatever the database's collation: an index on it is the same on every server.
-- In creation order: kg_title_key calls kg_name_key, kg_is_preprint kg_doi_key, and
-- kg_preprint_is_later kg_pmid_key. kg_name_key spells each Greek letter out (the table `greek` of
-- kg/identity_keys.json: alpha-synuclein and beta-synuclein are two titles), after NFKD has mapped
-- the micro sign to mu and the ohm sign to omega. No REVOKE: every role that writes these tables
-- evaluates them when the index is maintained.
CREATE OR REPLACE FUNCTION pg_temp.kg_key_ddl()
RETURNS TABLE (ord int, sig text, about text, ddl text)
LANGUAGE sql IMMUTABLE AS
$q$
SELECT * FROM (VALUES
(1, 'public.kg_orcid_key(text)',
 'Identity key (kg/identity_keys.json, key orcid); uq_* indexes use it: never replace it without a REINDEX. 20261117181500_prevent_duplicates.',
$ddl$CREATE OR REPLACE FUNCTION public.kg_orcid_key(_v text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$fn$ SELECT upper(substring(_v COLLATE "C" FROM '[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9Xx]')) $fn$;$ddl$),
(2, 'public.kg_doi_key(text)',
 'Identity key (kg/identity_keys.json, key doi); uq_* indexes use it: never replace it without a REINDEX. 20261117181500_prevent_duplicates.',
$ddl$CREATE OR REPLACE FUNCTION public.kg_doi_key(_v text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$fn$ SELECT CASE WHEN d ~ '^10\.[0-9.]+/[^[:space:]]+$' THEN d END
       FROM (SELECT regexp_replace(lower(regexp_replace(regexp_replace(_v COLLATE "C", '^[[:space:]]+|[[:space:]]+$', '', 'g'),
                                                        '^((https?://)?((dx|www)\.)?doi\.org/|doi:?[[:space:]]*)', '', 'i')), '/+$', '') AS d) x $fn$;$ddl$),
(3, 'public.kg_pmid_key(text)',
 'Identity key (kg/identity_keys.json, key pmid); uq_* indexes use it: never replace it without a REINDEX. 20261117181500_prevent_duplicates.',
$ddl$CREATE OR REPLACE FUNCTION public.kg_pmid_key(_v text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$fn$ SELECT CASE WHEN p ~ '^[0-9]+$' THEN nullif(ltrim(p, '0'), '') END
       FROM (SELECT regexp_replace(regexp_replace(_v COLLATE "C", '^[[:space:]]+|[[:space:]]+$', '', 'g'),
                                   '^pmid:?[[:space:]]*', '', 'i') AS p) x $fn$;$ddl$),
(4, 'public.kg_fon_key(text)',
 'Identity key (kg/identity_keys.json, key fon); uq_* indexes use it: never replace it without a REINDEX. 20261117181500_prevent_duplicates.',
$ddl$CREATE OR REPLACE FUNCTION public.kg_fon_key(_v text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$fn$ SELECT nullif(regexp_replace(upper(_v COLLATE "C"), '[^A-Z0-9]', '', 'g'), '') $fn$;$ddl$),
(5, 'public.kg_award_key(text)',
 'Identity key (kg/identity_keys.json, key award); uq_* indexes use it: never replace it without a REINDEX. 20261117181500_prevent_duplicates.',
$ddl$CREATE OR REPLACE FUNCTION public.kg_award_key(_v text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$fn$ SELECT coalesce(substring(upper(_v COLLATE "C") FROM '[A-Z][A-Z0-9]{2}[A-Z]{2}[0-9]{6}'),
                     nullif(regexp_replace(upper(_v COLLATE "C"), '[[:space:]]', '', 'g'), '')) $fn$;$ddl$),
(6, 'public.kg_name_key(text)',
 'Identity key (kg/identity_keys.json, key name); uq_* indexes use it: never replace it without a REINDEX. 20261117181500_prevent_duplicates.',
$ddl$CREATE OR REPLACE FUNCTION public.kg_name_key(_v text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$fn$ SELECT nullif(regexp_replace(lower(string_agg(coalesce(g.latin, c.ch), '' ORDER BY c.i) COLLATE "C"), '[^a-z0-9]', '', 'g'), '')
       FROM regexp_split_to_table(normalize(_v, NFKD), '') WITH ORDINALITY AS c(ch, i)
       LEFT JOIN (VALUES (E'\u0391', 'alpha'), (E'\u0392', 'beta'), (E'\u0393', 'gamma'), (E'\u0394', 'delta'),
                          (E'\u0395', 'epsilon'), (E'\u0396', 'zeta'), (E'\u0397', 'eta'), (E'\u0398', 'theta'),
                          (E'\u0399', 'iota'), (E'\u039a', 'kappa'), (E'\u039b', 'lambda'), (E'\u039c', 'mu'),
                          (E'\u039d', 'nu'), (E'\u039e', 'xi'), (E'\u039f', 'omicron'), (E'\u03a0', 'pi'),
                          (E'\u03a1', 'rho'), (E'\u03a3', 'sigma'), (E'\u03a4', 'tau'), (E'\u03a5', 'upsilon'),
                          (E'\u03a6', 'phi'), (E'\u03a7', 'chi'), (E'\u03a8', 'psi'), (E'\u03a9', 'omega'),
                          (E'\u03b1', 'alpha'), (E'\u03b2', 'beta'), (E'\u03b3', 'gamma'), (E'\u03b4', 'delta'),
                          (E'\u03b5', 'epsilon'), (E'\u03b6', 'zeta'), (E'\u03b7', 'eta'), (E'\u03b8', 'theta'),
                          (E'\u03b9', 'iota'), (E'\u03ba', 'kappa'), (E'\u03bb', 'lambda'), (E'\u03bc', 'mu'),
                          (E'\u03bd', 'nu'), (E'\u03be', 'xi'), (E'\u03bf', 'omicron'), (E'\u03c0', 'pi'),
                          (E'\u03c1', 'rho'), (E'\u03c2', 'sigma'), (E'\u03c3', 'sigma'), (E'\u03c4', 'tau'),
                          (E'\u03c5', 'upsilon'), (E'\u03c6', 'phi'), (E'\u03c7', 'chi'), (E'\u03c8', 'psi'),
                          (E'\u03c9', 'omega')) AS g(gr, latin) ON g.gr = c.ch $fn$;$ddl$),
(7, 'public.kg_title_key(text)',
 'Pairing rule (kg/identity_keys.json, key title), not an identity key: public.kg_link_publication_versions() pairs a preprint with its published version by it. Change it only with its TypeScript and Python copies. 20261117181500_prevent_duplicates.',
$ddl$CREATE OR REPLACE FUNCTION public.kg_title_key(_v text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$fn$ SELECT public.kg_name_key(regexp_replace(_v, '<[^>]*>', '', 'g')) $fn$;$ddl$),
(8, 'public.kg_is_preprint(text,text)',
 'Pairing rule (kg/identity_keys.json, key preprint): is a record a preprint, by its venue, its DOI prefix, or the shape of a bioRxiv/medRxiv DOI (10.1101/ alone is no preprint: Genome Res, Genes Dev and Learn Mem publish under it)? public.kg_link_publication_versions() uses it. Change it only with its TypeScript and Python copies. 20261117181500_prevent_duplicates.',
$ddl$CREATE OR REPLACE FUNCTION public.kg_is_preprint(_journal text, _doi text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$fn$ SELECT coalesce(lower(_journal COLLATE "C") ~ '(biorxiv|medrxiv|arxiv|research square|res sq|ssrn|psyarxiv|preprints)', false)
         OR coalesce(public.kg_doi_key(_doi) COLLATE "C" ~ '^10\.(64898|48550|21203|2139|31234|20944)/', false)
         OR coalesce(public.kg_doi_key(_doi) COLLATE "C" ~ '^10\.1101/([0-9]{4}\.[0-9]{2}\.[0-9]{2}\.)?[0-9]{6,}', false) $fn$;$ddl$),
(9, 'public.kg_preprint_is_later(integer,text,integer,text)',
 'Pairing rule (kg/identity_keys.json, key chronology): is the preprint later than its published version, by year when both are known and differ, else by PubMed id? public.kg_link_publication_versions() never links such a pair. Change it only with its TypeScript and Python copies. 20261117181500_prevent_duplicates.',
$ddl$CREATE OR REPLACE FUNCTION public.kg_preprint_is_later(_preprint_year integer, _preprint_pmid text, _published_year integer, _published_pmid text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$fn$ SELECT CASE WHEN _preprint_year IS NOT NULL AND _published_year IS NOT NULL AND _preprint_year <> _published_year
                 THEN _preprint_year > _published_year
                 ELSE coalesce(public.kg_pmid_key(_preprint_pmid)::numeric > public.kg_pmid_key(_published_pmid)::numeric, false) END $fn$;$ddl$)
) AS d(ord, sig, about, ddl)
$q$;

-- resource_links' type check (20261116150000 tools-04), with revision_of. The four rules it had are
-- kept as they were, except that produced no longer accepts a publication: a project's papers are
-- project_publications rows (the RePORTER credit), and one fact has one store. revision_of links a
-- publication to a publication, the later version to the earlier one, never both ways.
CREATE OR REPLACE FUNCTION pg_temp.kg_links_check_ddl() RETURNS text
LANGUAGE sql IMMUTABLE AS
$q$ SELECT $ddl$CREATE OR REPLACE FUNCTION public.resource_links_check_types()
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
                                 AND _o IN ('dataset', 'software', 'tool', 'ml_model', 'protocol', 'benchmark')
       WHEN 'revision_of' THEN _s = 'publication' AND _o = 'publication'
     END, false) THEN
    RAISE EXCEPTION 'resource_links: % cannot link a % to a %',
      NEW.predicate, coalesce(_s, '(missing row)'), coalesce(_o, '(missing row)')
      USING ERRCODE = 'check_violation',
            HINT = CASE WHEN NEW.predicate = 'produced' AND _o = 'publication'
                        THEN 'A project''s papers are project_publications rows (the RePORTER credit), not resource_links: one fact, one store.'
                        ELSE 'Each predicate is a kg/bbqs.linkml.yaml slot with a fixed domain and range; see the table comment.' END;
  END IF;
  IF NEW.predicate = 'revision_of' AND EXISTS (
       SELECT 1 FROM public.resource_links l
        WHERE l.predicate = 'revision_of' AND l.subject_id = NEW.object_id AND l.object_id = NEW.subject_id
          AND l.id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'resource_links: % revision_of % would make each a revision of the other', NEW.subject_id, NEW.object_id
      USING ERRCODE = 'check_violation',
            HINT = 'revision_of points from the later version (the published paper) to the earlier one (its preprint), never both ways.';
  END IF;
  RETURN NEW;
END
$fn$;$ddl$ $q$;

-- The type check as tools-04 created it, by fingerprint (its whitespace-folded body), so links-01
-- replaces it only if it is still that version: a body some later migration wrote is left alone.
CREATE OR REPLACE FUNCTION pg_temp.kg_links_check_tools04_md5() RETURNS text
LANGUAGE sql IMMUTABLE AS
$q$ SELECT '404296bd8ce7a2dae8a094c2125df72a'::text $q$;

-- THE PAIRING RULE, stated once. Two publications are versions of one work when both are KG nodes
-- (a spine row typed publication), their title keys are equal and at least 20 characters long,
-- exactly one of the two is a preprint (kg_is_preprint), exactly one record of that title group is
-- not a preprint (two published records sharing a title are a duplicate to merge first), the
-- preprint is not later than the published record (kg_preprint_is_later: by year, else by PubMed
-- id; a later "preprint" is another work with the same title, or a wrong year), and a project
-- credits both (project_publications: RePORTER's credit is the record, Principle III). Each pair
-- becomes resource_links (published, 'revision_of', preprint). _both_listed links only a pair whose
-- two records are both in _publication_ids, and returns the other pairs of their title groups as
-- would_link. SECURITY INVOKER, for service_role only: import-grant-publications calls it for the
-- papers it wrote, this script for the 5 known pairs (_both_listed). It names itself when its
-- caller did not (Principle X).
CREATE OR REPLACE FUNCTION pg_temp.kg_versions_ddl() RETURNS text
LANGUAGE sql IMMUTABLE AS
$q$ SELECT $ddl$CREATE OR REPLACE FUNCTION public.kg_link_publication_versions(
  _publication_ids uuid[] DEFAULT NULL, _basis text DEFAULT 'algorithmic', _dry boolean DEFAULT false,
  _both_listed boolean DEFAULT false)
RETURNS TABLE (subject_id uuid, object_id uuid, outcome text, detail text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS
$fn$
#variable_conflict use_column
DECLARE
  r  record;
  _n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.source_classes sc WHERE sc.code = _basis) THEN
    RAISE EXCEPTION 'kg_link_publication_versions: % is not a source class (public.source_classes.code)', _basis
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Principle X: a caller that did not name itself (no x-bbqs-client header, no set_actor) is named here.
  IF public.current_actor_via() = 'unknown' THEN
    PERFORM public.set_actor('kg_link_publication_versions');
  END IF;
  IF public.current_source_class() = 'unknown' THEN
    PERFORM public.set_source_class(_basis);
  END IF;
  FOR r IN
    WITH pub AS (
      SELECT p.id, p.resource_id, p.journal, p.doi, p.year, p.pmid,
             coalesce('PMID ' || nullif(btrim(p.pmid), ''), 'DOI ' || nullif(btrim(p.doi), ''), 'publication ' || p.id::text) AS lab,
             public.kg_title_key(p.title) AS tk,
             public.kg_is_preprint(p.journal, p.doi) AS pre
        FROM public.publications p
        JOIN public.resources s ON s.id = p.resource_id AND s.resource_type::text = 'publication'),
    grp AS (
      SELECT g.tk, count(*) FILTER (WHERE NOT g.pre) AS n_published
        FROM pub g
       WHERE length(g.tk) >= 20
       GROUP BY g.tk
      HAVING bool_or(g.pre) AND bool_or(NOT g.pre)
         AND (_publication_ids IS NULL OR bool_or(g.id = ANY (_publication_ids))))
    SELECT n.resource_id AS s, v.resource_id AS o, n.lab AS nlab, v.lab AS vlab,
           coalesce(nullif(btrim(v.journal), ''), nullif(btrim(v.doi), ''), 'preprint') AS venue,
           g.n_published,
           public.kg_preprint_is_later(v.year, v.pmid, n.year, n.pmid) AS later,
           coalesce(v.year::text, 'no year') AS vyear, coalesce(n.year::text, 'no year') AS nyear,
           (_publication_ids IS NULL OR NOT _both_listed
            OR (n.id = ANY (_publication_ids) AND v.id = ANY (_publication_ids))) AS listed,
           (SELECT string_agg(DISTINCT pr.grant_number, ', ' ORDER BY pr.grant_number)
              FROM public.project_publications a
              JOIN public.project_publications b ON b.project_id = a.project_id
              JOIN public.projects pr ON pr.id = a.project_id
             WHERE a.publication_id = n.id AND b.publication_id = v.id) AS shared,
           EXISTS (SELECT 1 FROM public.resource_links l
                    WHERE l.predicate = 'revision_of' AND l.subject_id = n.resource_id AND l.object_id = v.resource_id) AS linked,
           EXISTS (SELECT 1 FROM public.resource_links l
                    WHERE l.predicate = 'revision_of' AND l.subject_id = v.resource_id AND l.object_id = n.resource_id) AS reverse
      FROM grp g
      JOIN pub n ON n.tk = g.tk AND NOT n.pre
      JOIN pub v ON v.tk = g.tk AND v.pre
     ORDER BY n.lab, v.lab, n.id, v.id
  LOOP
    subject_id := r.s;
    object_id  := r.o;
    IF r.n_published > 1 THEN
      outcome := 'skipped';
      detail  := format('%s and preprint %s share their title with %s other record(s) that are not preprints: a duplicate to merge before any version link',
                        r.nlab, r.vlab, r.n_published - 1);
    ELSIF r.s = r.o THEN
      outcome := 'skipped';
      detail  := format('%s and preprint %s are two records on one node (both rows point at spine row %s): give the preprint its own spine row (a resources row typed publication, and its publications row pointed at it), then run public.kg_link_publication_versions again to link the two. Never merge them: each keeps its own PMID, DOI and date',
                        r.nlab, r.vlab, r.s);
    ELSIF r.later THEN
      outcome := 'skipped';
      detail  := format('preprint %s (%s) is later than %s (%s), by year or else by PubMed id: a preprint comes before its paper, so this is another work with the same title, or one of the two records has a wrong year. Not linked; a curator checks the two records',
                        r.vlab, r.vyear, r.nlab, r.nyear);
    ELSIF r.shared IS NULL THEN
      outcome := 'skipped';
      detail  := format('%s and preprint %s share their title, but no project credits both (project_publications): not linked', r.nlab, r.vlab);
    ELSIF r.reverse THEN
      outcome := 'skipped';
      detail  := format('preprint %s is recorded as a revision of %s (the reverse link): a curator decides which version is the later one', r.vlab, r.nlab);
    ELSIF r.linked THEN
      outcome := 'noop';
      detail  := format('%s revision_of preprint %s: already linked', r.nlab, r.vlab);
    ELSIF _dry OR NOT r.listed THEN
      outcome := 'would_link';
      detail  := format('%s revision_of preprint %s (%s): same title, both credited to %s%s', r.nlab, r.vlab, r.venue, r.shared,
                        CASE WHEN r.listed THEN '' ELSE ' (not linked by this call: it links only a pair whose two records are both listed)' END);
    ELSE
      INSERT INTO public.resource_links (subject_id, predicate, object_id, basis, evidence)
      VALUES (r.s, 'revision_of', r.o, _basis,
              format('%s revises preprint %s (%s): same title, both credited to %s (project_publications)', r.nlab, r.vlab, r.venue, r.shared))
      ON CONFLICT (subject_id, predicate, object_id) DO NOTHING;
      GET DIAGNOSTICS _n = ROW_COUNT;
      outcome := CASE WHEN _n > 0 THEN 'done' ELSE 'noop' END;
      detail  := format('%s revision_of preprint %s (%s): same title, both credited to %s', r.nlab, r.vlab, r.venue, r.shared);
    END IF;
    RETURN NEXT;
  END LOOP;
END
$fn$;$ddl$ $q$;

-- Is a partial-index predicate the one this script writes (or none, which enforces the key on
-- every row)? Compared without parentheses and spaces, which pg_get_expr adds or drops.
CREATE OR REPLACE FUNCTION pg_temp.kg_same_pred(_have text, _want text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS
$q$ SELECT coalesce(_have, '') = ''
        OR regexp_replace(_have, '[()[:space:]]', '', 'g') = regexp_replace(_want, '[()[:space:]]', '', 'g') $q$;

-- One row of a colliding group, for a curator: id, label, the raw value, when it was created, its
-- node, and how many rows reference it through each foreign key (what a merge must repoint).
CREATE OR REPLACE FUNCTION pg_temp.kg_row_text(_table text, _id uuid, _col text, _label text)
RETURNS text LANGUAGE plpgsql AS
$fn$
DECLARE
  _rel  regclass := to_regclass(format('public.%I', _table));
  _has  text[];
  _l    text;
  _v    text;
  _c    text;
  _r    text;
  _refs text[] := '{}';
  _k    bigint;
  fk    record;
BEGIN
  SELECT array_agg(a.attname::text) INTO _has
    FROM pg_attribute a WHERE a.attrelid = _rel AND a.attnum > 0 AND NOT a.attisdropped;
  EXECUTE format('SELECT %s, %I::text, %s, %s FROM public.%I WHERE id = $1',
                 CASE WHEN _label = ANY (_has) THEN format('%I::text', _label) ELSE 'NULL::text' END,
                 _col,
                 CASE WHEN 'created_at' = ANY (_has) THEN 'created_at::date::text' ELSE 'NULL::text' END,
                 CASE WHEN 'resource_id' = ANY (_has) THEN 'resource_id::text' ELSE 'NULL::text' END,
                 _table)
     INTO _l, _v, _c, _r USING _id;
  FOR fk IN
    SELECT c.conrelid::regclass AS rel, a.attname AS col, ra.attname AS refcol
      FROM pg_constraint c
      JOIN pg_attribute a  ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND c.confrelid = _rel AND cardinality(c.conkey) = 1
     ORDER BY c.conrelid::regclass::text, a.attname
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = (SELECT %I FROM public.%I WHERE id = $1)', fk.rel, fk.col, fk.refcol, _table)
       INTO _k USING _id;
    IF _k > 0 THEN
      _refs := _refs || format('%s.%s %s', fk.rel, fk.col, _k);
    END IF;
  END LOOP;
  RETURN format('%s %s (%s %s, created %s, node %s; referenced by %s)',
                _id, coalesce(quote_literal(_l), '(no label)'), _col, coalesce(quote_literal(_v), 'NULL'),
                coalesce(_c, '?'), coalesce(_r, 'none'), coalesce(nullif(array_to_string(_refs, ', '), ''), 'nothing'));
END
$fn$;

-- What a curator does with a group of rows that share a key. Publications on one node (nodes-01)
-- that share no DOI or PMID key are usually a preprint and its paper: two records, so one gets its
-- own spine row and the two are linked (revision_of), never merged. Any other group is one record
-- held twice (merged), or holds a wrong value (corrected).
CREATE OR REPLACE FUNCTION pg_temp.kg_group_advice(_table text, _expr text, _ids uuid[]) RETURNS text
LANGUAGE plpgsql STABLE AS
$fn$
BEGIN
  IF _table = 'publications' AND _expr = 'resource_id' AND NOT EXISTS (
       SELECT 1 FROM public.publications a JOIN public.publications b ON a.id < b.id
        WHERE a.id = ANY (_ids) AND b.id = ANY (_ids)
          AND (public.kg_doi_key(a.doi) = public.kg_doi_key(b.doi) OR public.kg_pmid_key(a.pmid) = public.kg_pmid_key(b.pmid))) THEN
    RETURN 'These publication rows share no DOI or PMID key, so they are two records on one node, often a preprint and its published version: give each but one its own spine row (a resources row typed publication, and its publications row pointed at it), then link the versions with public.kg_link_publication_versions. Never merge a preprint into its paper: each keeps its own PMID, DOI and date. If two of them are one paper entered twice, merge those two (keep one, repoint what references the other, delete it).';
  END IF;
  RETURN 'If they are one record, merge them into one row (keep one, repoint what references the others, delete the rest); if one of them holds a wrong value (another person''s ORCID iD, a DOI typed on the wrong paper), correct it.';
END
$fn$;

-- Create one unique index on a key, if the live rows already satisfy it (blocks index-01 to
-- index-07 and nodes-01). _expr is the key: public.kg_<key>_key(<column>), or a bare column. Every
-- outcome is a report row, never an exception:
--   * no such table or column here (a migration not applied yet): skipped;
--   * an index of that name exists: noop if it is a valid unique index of this table on exactly
--     this key, else an error (rename or drop it first);
--   * a valid unique index on exactly this key under another name: noop, naming it;
--   * rows share a key: one skipped row per group, listing every row and what references it, and
--     the index is not created; nothing else is blocked;
--   * else CREATE UNIQUE INDEX (done). The table is locked SHARE (as CREATE INDEX locks it) BEFORE
--     the check, so no write can slip a duplicate in between the check and the build.
CREATE OR REPLACE FUNCTION pg_temp.kg_unique_key(_index text, _table text, _expr text, _label text)
RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  _rel   regclass := to_regclass(format('public.%I', _table));
  _col   text     := CASE WHEN _expr ~ '^[a-z_]+$' THEN _expr ELSE substring(_expr FROM '\(([a-z_]+)\)$') END;
  _keyfn text     := substring(_expr FROM '^(public\.[a-z_]+)\(');
  _key   text     := regexp_replace(_expr, '\mpublic\.', '', 'g');
  _have  record;
  _g     record;
  _n     int := 0;
  _rows  text;
  _crt   text;
BEGIN
  IF _rel IS NULL THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('unique key', _index, 'skipped', format('public.%I does not exist in this database: nothing to index', _table));
    RETURN;
  END IF;
  IF _col IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = _rel AND a.attname = _col AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = _rel AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped) THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('unique key', _index, 'skipped',
            format('public.%I has no column %s (or no id) here: the migration that adds it is not applied yet; nothing to index', _table, coalesce(_col, _expr)));
    RETURN;
  END IF;
  IF _keyfn IS NOT NULL AND to_regprocedure(_keyfn || '(text)') IS NULL THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('unique key', _index, 'skipped', format('%s(text) does not exist (see keys-01): the index cannot be built on it', _keyfn));
    RETURN;
  END IF;

  -- An index (or any relation) of this name already exists: it must be this key's unique index.
  SELECT c.relkind, i.indrelid, i.indisunique, i.indisvalid, i.indnatts,
         regexp_replace(pg_get_indexdef(c.oid, 1, true), '\mpublic\.', '', 'g') AS k1,
         regexp_replace(coalesce(pg_get_expr(i.indpred, i.indrelid, true), ''), '\mpublic\.', '', 'g') AS p1,
         CASE WHEN c.relkind = 'i' THEN pg_get_indexdef(c.oid) END AS def
    INTO _have
    FROM pg_class c LEFT JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname = _index;
  IF FOUND THEN
    IF _have.relkind = 'i' AND _have.indrelid = _rel AND _have.indisunique AND _have.indisvalid AND _have.indnatts = 1
       AND _have.k1 = _key AND pg_temp.kg_same_pred(_have.p1, _key || ' IS NOT NULL') THEN
      INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
      VALUES ('unique key', _index, 'noop', 'already enforced: ' || _have.def);
    ELSE
      INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
      VALUES ('unique key', _index, 'error',
              format('public.%I exists but is not a valid unique index of public.%I on %s: %s. Rename or drop it (an index an interrupted CREATE INDEX CONCURRENTLY left is invalid), then run this script again.',
                     _index, _table, _key, coalesce(_have.def, 'a relation of kind ' || _have.relkind::text)));
    END IF;
    RETURN;
  END IF;

  -- The same key, already enforced under another name.
  SELECT c.relname, pg_get_indexdef(c.oid) AS def INTO _have
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = _rel AND i.indisunique AND i.indisvalid AND i.indnatts = 1
     AND regexp_replace(pg_get_indexdef(i.indexrelid, 1, true), '\mpublic\.', '', 'g') = _key
     AND pg_temp.kg_same_pred(regexp_replace(coalesce(pg_get_expr(i.indpred, i.indrelid, true), ''), '\mpublic\.', '', 'g'),
                              _key || ' IS NOT NULL')
   ORDER BY c.relname
   LIMIT 1;
  IF FOUND THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('unique key', _index, 'noop', format('already enforced by %s: %s', _have.relname, _have.def));
    RETURN;
  END IF;

  IF NOT pg_has_role((SELECT c.relowner FROM pg_class c WHERE c.oid = _rel), 'USAGE') THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('unique key', _index, 'skipped',
            format('only the owner of public.%I (%s) can index it: run this script as that role', _table,
                   (SELECT c.relowner::regrole::text FROM pg_class c WHERE c.oid = _rel)));
    RETURN;
  END IF;

  -- Writes to the table wait from here to the end of the run.
  EXECUTE format('LOCK TABLE public.%I IN SHARE MODE', _table);
  _crt := CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = _rel AND a.attname = 'created_at' AND NOT a.attisdropped)
               THEN 't.created_at' ELSE 'NULL::timestamptz' END;
  FOR _g IN EXECUTE format(
      'SELECT x.k, count(*) AS n, array_agg(x.id ORDER BY x.c NULLS LAST, x.id) AS ids
         FROM (SELECT t.id, %s AS c, (%s)::text AS k FROM public.%I t) x
        WHERE x.k IS NOT NULL
        GROUP BY x.k HAVING count(*) > 1
        ORDER BY x.k', _crt, _expr, _table)
  LOOP
    _n := _n + 1;
    SELECT string_agg(pg_temp.kg_row_text(_table, r.id, _col, _label), '; ' ORDER BY r.ord) INTO _rows
      FROM unnest(_g.ids) WITH ORDINALITY AS r(id, ord)
     WHERE r.ord <= 20;
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('unique key', format('%s: %s', _index, _g.k), 'skipped',
            format('%s rows share this key, so %s is not created: %s%s. %s Then run this script again; nothing else waits on it.',
                   _g.n, _index, _rows, CASE WHEN _g.n > 20 THEN format('; and %s more', _g.n - 20) ELSE '' END,
                   pg_temp.kg_group_advice(_table, _expr, _g.ids)));
  END LOOP;
  IF _n > 0 THEN
    RETURN;
  END IF;

  EXECUTE format('CREATE UNIQUE INDEX %I ON public.%I (%s) WHERE %s IS NOT NULL', _index, _table, _expr, _expr);
  EXECUTE format('COMMENT ON INDEX public.%I IS %L', _index,
                 CASE WHEN _keyfn IS NULL
                      THEN 'One detail row per KG node (spine row): 20261117181500_prevent_duplicates, nodes-01.'
                      ELSE format('Identity key %s (kg/identity_keys.json): a second row with the same key is refused (23505). 20261117181500_prevent_duplicates.', _key) END);
  INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
  VALUES ('unique key', _index, 'done', 'created: ' || pg_get_indexdef(to_regclass(format('public.%I', _index))));
END
$fn$;

-- Does resource_links accept revision_of here: the table, a CHECK that allows it, and a type check
-- that has a rule for it? links-02, versions-01 and versions-02 act only then.
CREATE OR REPLACE FUNCTION pg_temp.kg_revision_of_accepted() RETURNS boolean
LANGUAGE sql STABLE AS
$q$
  SELECT to_regclass('public.resource_links') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = to_regclass('public.resource_links') AND c.conname = 'resource_links_predicate_check'
                    AND pg_get_constraintdef(c.oid) LIKE '%''revision\_of''%')
     AND EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public.resource_links_check_types()') AND p.prosrc LIKE '%''revision\_of''%')
$q$;

-- The 5 preprint/published pairs of the 2026-11-17 export (kg/export/quality.json, duplicates
-- groups of kind "versions"): the published record's PMID, its preprint's, and the grant that
-- credits both.
CREATE OR REPLACE FUNCTION pg_temp.kg_known_versions()
RETURNS TABLE (ord int, label text, published_pmid text, preprint_pmid text, grant_number text)
LANGUAGE sql IMMUTABLE AS
$q$
SELECT * FROM (VALUES
  (1, 'BRAID',              '42131509', '41040807', 'R61MH135407'),
  (2, 'CaBLAM',             '41331138', '37425712', 'R34DA059500'),
  (3, 'CapuchinAI',         '42516064', '41292955', 'R34DA061925'),
  (4, 'Dynamical Modeling', '41321375', '41040797', 'R61MH135407'),
  (5, 'gerbil vocal usage', '39680425', '39282260', 'R34DA059513')
) AS v(ord, label, published_pmid, preprint_pmid, grant_number)
$q$;

-- Why the pairing rule did not pair two publication rows (versions-01 asks only for the 5 known pairs).
CREATE OR REPLACE FUNCTION pg_temp.kg_why_not_paired(_a uuid, _b uuid) RETURNS text
LANGUAGE plpgsql STABLE AS
$fn$
DECLARE a record; b record; _w text[] := '{}';
BEGIN
  SELECT p.id, p.pmid, p.year, p.title, p.journal, p.doi, p.resource_id, s.resource_type::text AS rtype,
         public.kg_title_key(p.title) AS tk, public.kg_is_preprint(p.journal, p.doi) AS pre
    INTO a FROM public.publications p LEFT JOIN public.resources s ON s.id = p.resource_id WHERE p.id = _a;
  SELECT p.id, p.pmid, p.year, p.title, p.journal, p.doi, p.resource_id, s.resource_type::text AS rtype,
         public.kg_title_key(p.title) AS tk, public.kg_is_preprint(p.journal, p.doi) AS pre
    INTO b FROM public.publications p LEFT JOIN public.resources s ON s.id = p.resource_id WHERE p.id = _b;
  IF a.rtype IS DISTINCT FROM 'publication' THEN
    _w := _w || format('PMID %s is no publication node (spine row %s, type %s)', a.pmid, coalesce(a.resource_id::text, 'none'), coalesce(a.rtype, 'none'));
  END IF;
  IF b.rtype IS DISTINCT FROM 'publication' THEN
    _w := _w || format('PMID %s is no publication node (spine row %s, type %s)', b.pmid, coalesce(b.resource_id::text, 'none'), coalesce(b.rtype, 'none'));
  END IF;
  IF a.pre THEN
    _w := _w || format('PMID %s reads as a preprint (journal %L, DOI %L)', a.pmid, a.journal, a.doi);
  END IF;
  IF NOT b.pre THEN
    _w := _w || format('PMID %s does not read as a preprint (journal %L, DOI %L)', b.pmid, b.journal, b.doi);
  END IF;
  IF public.kg_preprint_is_later(b.year, b.pmid, a.year, a.pmid) THEN
    _w := _w || format('preprint PMID %s (%s) is later than PMID %s (%s), by year or else by PubMed id', b.pmid, coalesce(b.year::text, 'no year'), a.pmid, coalesce(a.year::text, 'no year'));
  END IF;
  IF a.tk IS DISTINCT FROM b.tk THEN
    _w := _w || format('their titles differ (%L / %L)', a.title, b.title);
  ELSIF length(coalesce(a.tk, '')) < 20 THEN
    _w := _w || format('the title key %L is shorter than 20 characters', a.tk);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.project_publications x JOIN public.project_publications y ON y.project_id = x.project_id
                  WHERE x.publication_id = _a AND y.publication_id = _b) THEN
    _w := _w || 'no project credits both (project_publications)'::text;
  END IF;
  RETURN coalesce(nullif(array_to_string(_w, '; '), ''), 'no reason found: compare the two rows by hand');
END
$fn$;

-- ================================================================================================
-- 2. THE BLOCKS, in run order. Each is a pg_temp function; section 3 runs them. A block reports
--    every decision (done / noop / skipped / report / error) and never writes past a failed guard.
-- ================================================================================================

-- ------------------------------------------------------------------------------------------------
-- [keys-01] Create the identity-key functions where missing
-- A function of that name and arguments that exists with another body, volatility, strictness,
-- parallel safety, search_path or return type is an ERROR (the run then changes nothing): this
-- script never replaces one, because Postgres lets CREATE OR REPLACE change a function an index is
-- built on without re-indexing, and the index would keep keys the new body no longer computes. A
-- developer reconciles it in a migration of its own (drop it, or replace it and REINDEX).
CREATE OR REPLACE FUNCTION pg_temp.kg_b_keys_01() RETURNS void LANGUAGE plpgsql AS
$blk$
DECLARE
  d      record;
  p      record;
  _oid   regprocedure;
  _body  text;
  _diff  text[];
BEGIN
  FOR d IN SELECT * FROM pg_temp.kg_key_ddl() ORDER BY 1 LOOP
    _body := pg_temp.kg_fn_body(d.ddl);
    _oid  := to_regprocedure(d.sig);
    IF _oid IS NULL THEN
      EXECUTE d.ddl;
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', d.sig, d.about);
      INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
      VALUES ('key function', d.sig, 'done', 'created: ' || pg_temp.kg_norm_src(_body));
      CONTINUE;
    END IF;
    SELECT pr.prosrc, pr.provolatile, pr.proisstrict, pr.proparallel, pr.proconfig,
           pr.prorettype::regtype::text AS ret, l.lanname
      INTO p FROM pg_proc pr JOIN pg_language l ON l.oid = pr.prolang WHERE pr.oid = _oid;
    _diff := '{}';
    -- Line ends aside (a paste may carry CRLF), the body must be this file's, character for character.
    IF replace(p.prosrc, E'\r', '') IS DISTINCT FROM replace(_body, E'\r', '') THEN
      _diff := _diff || format('its body is %L', pg_temp.kg_norm_src(p.prosrc));
    END IF;
    IF p.lanname <> 'sql' THEN _diff := _diff || format('it is LANGUAGE %s', p.lanname); END IF;
    IF p.provolatile <> 'i' THEN _diff := _diff || 'it is not IMMUTABLE'::text; END IF;
    IF p.proisstrict IS DISTINCT FROM (d.ddl ~ '\mSTRICT\M') THEN
      _diff := _diff || CASE WHEN p.proisstrict THEN 'it is STRICT' ELSE 'it is not STRICT' END;
    END IF;
    IF p.proparallel <> 's' THEN _diff := _diff || 'it is not PARALLEL SAFE'::text; END IF;
    IF p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
      _diff := _diff || format('its settings are %s, not search_path=pg_catalog', coalesce(array_to_string(p.proconfig, ', '), 'none'));
    END IF;
    IF p.ret <> substring(d.ddl FROM 'RETURNS ([a-z]+)') THEN _diff := _diff || format('it returns %s', p.ret); END IF;
    IF cardinality(_diff) > 0 THEN
      INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
      VALUES ('key function', d.sig, 'error',
              format('%s exists, but not as kg/identity_keys.json''s rule: %s. This script never replaces an identity-key function (an index built on it would keep the old keys). A developer reconciles it in a migration of its own: drop it if nothing uses it, or replace it and REINDEX every index on it.',
                     d.sig, array_to_string(_diff, '; ')));
    ELSIF obj_description(_oid, 'pg_proc') IS DISTINCT FROM d.about THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', d.sig, d.about);
      INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
      VALUES ('key function', d.sig, 'done', 'already present with this body; its comment set');
    ELSE
      INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
      VALUES ('key function', d.sig, 'noop', 'already present with this body');
    END IF;
  END LOOP;
END
$blk$;

-- ------------------------------------------------------------------------------------------------
-- [keys-02] Self-test: this database computes the 97 SQL vectors of kg/identity_keys.json
-- The two blocks between markers are generated from kg/identity_keys.json: identity-vectors (one
-- row per line: kind, input, second input, want) and chronology-vectors (preprint year, preprint
-- pmid, published year, published pmid, want: kg_preprint_is_later). ASCII only, every other
-- character an E'' escape. The same vectors hold the TypeScript (tests/guards/identity-normalization)
-- and Python (kg/ci_check.py) copies, and tests/guards/kg-identity-keys checks that these blocks are
-- the JSON's. A mismatch is an error row: this server would compute other keys than the write paths
-- and the export gate.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_keys_02() RETURNS void LANGUAGE plpgsql AS
$blk$
DECLARE
  r     record;
  c     record;
  _n    int := 0;
  _bad  int := 0;
BEGIN
  FOR r IN
    SELECT v.kind, v.a, v.b, v.want, g.got
      FROM (VALUES
-- identity-vectors:begin (generated from kg/identity_keys.json: kind, input, second input, want)
  ('orcid', '0000-0002-1825-0097', NULL, '0000-0002-1825-0097'),
  ('orcid', 'https://orcid.org/0000-0002-1825-009x', NULL, '0000-0002-1825-009X'),
  ('orcid', ' orcid.org/0000-0002-1825-0097 ', NULL, '0000-0002-1825-0097'),
  ('orcid', '0000000218250097', NULL, NULL),
  ('orcid', 'n/a', NULL, NULL),
  ('orcid', '', NULL, NULL),
  ('orcid', NULL, NULL, NULL),
  ('doi', '10.7554/eLife.89892', NULL, '10.7554/elife.89892'),
  ('doi', 'https://doi.org/10.7554/ELIFE.89892/', NULL, '10.7554/elife.89892'),
  ('doi', 'DOI: 10.1101/2023.06.25.546478', NULL, '10.1101/2023.06.25.546478'),
  ('doi', 'http://dx.doi.org/10.1000/x', NULL, '10.1000/x'),
  ('doi', 'doi.org/10.1000/ABC.1', NULL, '10.1000/abc.1'),
  ('doi', 'https://www.doi.org/10.1000/XYZ.2', NULL, '10.1000/xyz.2'),
  ('doi', 'dx.doi.org/10.1000/x', NULL, '10.1000/x'),
  ('doi', 'DOI 10.1000/x', NULL, '10.1000/x'),
  ('doi', 'doi10.1000/x', NULL, '10.1000/x'),
  ('doi', 'https://doi.org/doi:10.1000/x', NULL, NULL),
  ('doi', E'\t10.1000/x\n', NULL, '10.1000/x'),
  ('doi', E'doi:\u00a010.1000/x', NULL, NULL),
  ('doi', '10.1000/a b', NULL, NULL),
  ('doi', 'not a doi', NULL, NULL),
  ('doi', E'10.1000/x\n/', NULL, NULL),
  ('doi', '', NULL, NULL),
  ('doi', NULL, NULL, NULL),
  ('pmid', '41331138', NULL, '41331138'),
  ('pmid', ' 0041331138', NULL, '41331138'),
  ('pmid', 'PMID: 41331138', NULL, '41331138'),
  ('pmid', 'pmid:41331138', NULL, '41331138'),
  ('pmid', 'PMID 41331138', NULL, '41331138'),
  ('pmid', E'pmid\t0041331138', NULL, '41331138'),
  ('pmid', '4133 1138', NULL, NULL),
  ('pmid', E'\uff14\uff11', NULL, NULL),
  ('pmid', '0', NULL, NULL),
  ('pmid', 'abc', NULL, NULL),
  ('pmid', '', NULL, NULL),
  ('pmid', NULL, NULL, NULL),
  ('fon', 'RFA-NS-27-002', NULL, 'RFANS27002'),
  ('fon', 'rfa ns 27 002', NULL, 'RFANS27002'),
  ('fon', 'NSF 26-526', NULL, 'NSF26526'),
  ('fon', E'Stra\u00dfe-1', NULL, 'STRAE1'),
  ('fon', '  ', NULL, NULL),
  ('fon', NULL, NULL, NULL),
  ('award', '1U01MH143789-01', NULL, 'U01MH143789'),
  ('award', '5r34da059506-02', NULL, 'R34DA059506'),
  ('award', 'RF1MH999999', NULL, 'RF1MH999999'),
  ('award', '1UG3NS999999-01A1', NULL, 'UG3NS999999'),
  ('award', 'NSF 2123456', NULL, 'NSF2123456'),
  ('award', '', NULL, NULL),
  ('award', NULL, NULL, NULL),
  ('name', 'UNIVERSITY OF CALIFORNIA, SAN DIEGO', NULL, 'universityofcaliforniasandiego'),
  ('name', 'University of California San Diego', NULL, 'universityofcaliforniasandiego'),
  ('name', 'CHILDREN''S HOSP OF PHILADELPHIA', NULL, 'childrenshospofphiladelphia'),
  ('name', E'Universit\u00e9 Paris Cit\u00e9', NULL, 'universitepariscite'),
  ('name', E'\u0130stanbul \u00dcniversitesi', NULL, 'istanbuluniversitesi'),
  ('name', E'Stra\u00dfe', NULL, 'strae'),
  ('name', E'\u212aelvin Lab', NULL, 'kelvinlab'),
  ('name', 'Bijan  Pesaran', NULL, 'bijanpesaran'),
  ('name', E'Laboratory of \u03b1-Synuclein Biology', NULL, 'laboratoryofalphasynucleinbiology'),
  ('name', E'\u03a3-\u03a9 Center', NULL, 'sigmaomegacenter'),
  ('name', E'\u00b5-Lab', NULL, 'mulab'),
  ('name', E'\u039b\u03cc\u03b3\u03bf\u03c2 Institute', NULL, 'lambdaomicrongammaomicronsigmainstitute'),
  ('name', E'\u5317\u4eac\u5927\u5b66', NULL, NULL),
  ('name', '  ', NULL, NULL),
  ('name', NULL, NULL, NULL),
  ('title', 'CaBLAM: a high-contrast bioluminescent Ca<sup>2+</sup> indicator', NULL, 'cablamahighcontrastbioluminescentca2indicator'),
  ('title', 'CaBLAM! a high-contrast bioluminescent Ca[2+] indicator', NULL, 'cablamahighcontrastbioluminescentca2indicator'),
  ('title', E'Ca\u00b2\u207a imaging', NULL, 'ca2imaging'),
  ('title', E'\u03b1-synuclein aggregation in dopaminergic neurons', NULL, 'alphasynucleinaggregationindopaminergicneurons'),
  ('title', E'\u03b2-synuclein aggregation in dopaminergic neurons', NULL, 'betasynucleinaggregationindopaminergicneurons'),
  ('title', E'\u00b5-opioid receptors and \u03b8/\u03b3 coupling', NULL, 'muopioidreceptorsandthetagammacoupling'),
  ('title', E'\u03bc-opioid receptors and \u0398/\u0393 coupling', NULL, 'muopioidreceptorsandthetagammacoupling'),
  ('title', NULL, NULL, NULL),
  ('preprint', 'bioRxiv', '10.64898/2026.06.01.728862', 'true'),
  ('preprint', 'Nat Methods', '10.1038/s41592-025-02972-0', 'false'),
  ('preprint', 'ArXiv', NULL, 'true'),
  ('preprint', 'Res Sq', '10.21203/rs.3.rs-1/v1', 'true'),
  ('preprint', NULL, 'https://doi.org/10.1101/2023.03.11.532197', 'true'),
  ('preprint', 'Learn Mem', '10.1101/lm.054001.124', 'false'),
  ('preprint', 'Genome Res', 'https://doi.org/10.1101/gr.279001.124', 'false'),
  ('preprint', NULL, '10.1101/gad.350000.122', 'false'),
  ('preprint', NULL, '10.1101/2024.05.01.590001', 'true'),
  ('preprint', NULL, '10.1101/087593', 'true'),
  ('preprint', NULL, 'doi:10.1101/2020.03.17.20037572', 'true'),
  ('preprint', 'Elife', '10.7554/eLife.89892', 'false'),
  ('preprint', NULL, NULL, 'false')
-- identity-vectors:end
           ) AS v(kind, a, b, want)
     CROSS JOIN LATERAL (
       SELECT CASE v.kind
                WHEN 'orcid'    THEN public.kg_orcid_key(v.a)
                WHEN 'doi'      THEN public.kg_doi_key(v.a)
                WHEN 'pmid'     THEN public.kg_pmid_key(v.a)
                WHEN 'fon'      THEN public.kg_fon_key(v.a)
                WHEN 'award'    THEN public.kg_award_key(v.a)
                WHEN 'name'     THEN public.kg_name_key(v.a)
                WHEN 'title'    THEN public.kg_title_key(v.a)
                WHEN 'preprint' THEN public.kg_is_preprint(v.a, v.b)::text
              END AS got) g
  LOOP
    _n := _n + 1;
    IF r.got IS DISTINCT FROM r.want THEN
      _bad := _bad + 1;
      INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
      VALUES ('identity vector',
              format('%s(%s%s)', r.kind, quote_nullable(r.a), CASE WHEN r.kind = 'preprint' THEN ', ' || quote_nullable(r.b) ELSE '' END),
              'error',
              format('this database computes %s, kg/identity_keys.json wants %s: its key would differ from the write paths'' and the export gate''s. Check the function in keys-01 and this server''s Postgres version; nothing is changed until they agree.',
                     quote_nullable(r.got), quote_nullable(r.want)));
    END IF;
  END LOOP;
  FOR c IN
    SELECT v.py, v.pp, v.uy, v.up, v.want, public.kg_preprint_is_later(v.py, v.pp, v.uy, v.up) AS got
      FROM (VALUES
-- chronology-vectors:begin (generated from kg/identity_keys.json: preprint year, preprint pmid, published year, published pmid, want)
  (2025, '41040807', 2026, '42131509', false),
  (2025, '99999999', 2026, '10000000', false),
  (2025, '37425712', 2019, '41331138', true),
  (2026, '90000017', 2026, '90000016', true),
  (2026, '90000016', 2026, '90000017', false),
  (NULL, '200002', NULL, '200001', true),
  (NULL, 'PMID: 0200001', 2026, '200002', false),
  (2026, '123456789012345678901', NULL, '99', true),
  (2026, 'abc', 2026, '123', false),
  (2025, NULL, 2026, NULL, false),
  (2026, NULL, 2025, NULL, true),
  (NULL, NULL, NULL, NULL, false)
-- chronology-vectors:end
           ) AS v(py, pp, uy, up, want)
  LOOP
    _n := _n + 1;
    IF c.got IS DISTINCT FROM c.want THEN
      _bad := _bad + 1;
      INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
      VALUES ('identity vector',
              format('chronology(%s, %s, %s, %s)', quote_nullable(c.py), quote_nullable(c.pp), quote_nullable(c.uy), quote_nullable(c.up)),
              'error',
              format('this database computes %s, kg/identity_keys.json wants %s: it would pair preprints and papers otherwise than the export gate. Check kg_preprint_is_later in keys-01; nothing is changed until they agree.',
                     quote_nullable(c.got), quote_nullable(c.want)));
    END IF;
  END LOOP;
  IF _bad = 0 THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('identity vectors', 'kg/identity_keys.json', 'report',
            format('%s of %s vectors agree (orcid, doi, pmid, fon, award, name, title, preprint, chronology): this database computes the same keys as kg/identity_keys.py and _shared/identity-keys.ts.', _n, _n));
  END IF;
END
$blk$;

-- ------------------------------------------------------------------------------------------------
-- [index-01 .. index-07] One unique index per identity key (pg_temp.kg_unique_key, section 1).
-- No index on a funding call's URL: a notice URL can be a landing page that lists several calls.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_index_01() RETURNS void LANGUAGE plpgsql AS
$blk$ BEGIN
  PERFORM pg_temp.kg_unique_key('uq_investigators_orcid_key', 'investigators', 'public.kg_orcid_key(orcid)', 'name');
END $blk$;
CREATE OR REPLACE FUNCTION pg_temp.kg_b_index_02() RETURNS void LANGUAGE plpgsql AS
$blk$ BEGIN
  PERFORM pg_temp.kg_unique_key('uq_publications_doi_key', 'publications', 'public.kg_doi_key(doi)', 'title');
END $blk$;
CREATE OR REPLACE FUNCTION pg_temp.kg_b_index_03() RETURNS void LANGUAGE plpgsql AS
$blk$ BEGIN
  PERFORM pg_temp.kg_unique_key('uq_publications_pmid_key', 'publications', 'public.kg_pmid_key(pmid)', 'title');
END $blk$;
CREATE OR REPLACE FUNCTION pg_temp.kg_b_index_04() RETURNS void LANGUAGE plpgsql AS
$blk$ BEGIN
  PERFORM pg_temp.kg_unique_key('uq_organizations_name_key', 'organizations', 'public.kg_name_key(name)', 'name');
END $blk$;
CREATE OR REPLACE FUNCTION pg_temp.kg_b_index_05() RETURNS void LANGUAGE plpgsql AS
$blk$ BEGIN
  PERFORM pg_temp.kg_unique_key('uq_grants_award_key', 'grants', 'public.kg_award_key(grant_number)', 'title');
END $blk$;
CREATE OR REPLACE FUNCTION pg_temp.kg_b_index_06() RETURNS void LANGUAGE plpgsql AS
$blk$ BEGIN
  PERFORM pg_temp.kg_unique_key('uq_projects_award_key', 'projects', 'public.kg_award_key(grant_number)', 'grant_number');
END $blk$;
CREATE OR REPLACE FUNCTION pg_temp.kg_b_index_07() RETURNS void LANGUAGE plpgsql AS
$blk$ BEGIN
  PERFORM pg_temp.kg_unique_key('uq_funding_opportunities_fon_key', 'funding_opportunities', 'public.kg_fon_key(fon)', 'title');
END $blk$;

-- ------------------------------------------------------------------------------------------------
-- [nodes-01] One detail row per KG node: uq_<table>_resource_id on the 13 node tables
-- (kg/identity_keys.json one_row_per_node). One decision per table.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_nodes_01() RETURNS void LANGUAGE plpgsql AS
$blk$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      (1, 'investigators', 'name'), (2, 'organizations', 'name'), (3, 'grants', 'grant_number'),
      (4, 'publications', 'title'), (5, 'software_tools', 'name'), (6, 'funding_opportunities', 'fon'),
      (7, 'dandisets', 'dandiset_id'), (8, 'species', 'name'), (9, 'device_models', 'model_name'),
      (10, 'device_manufacturers', 'name'), (11, 'device_categories', 'key'), (12, 'jobs', 'title'),
      (13, 'announcements', 'title')
    ) AS v(n, tbl, lab)
    ORDER BY 1
  LOOP
    PERFORM pg_temp.kg_unique_key('uq_' || t.tbl || '_resource_id', t.tbl, 'resource_id', t.lab);
  END LOOP;
END
$blk$;

-- ------------------------------------------------------------------------------------------------
-- [links-01] resource_links accepts revision_of; produced no longer accepts a publication
-- The CHECK gets the five predicates, and resource_links_check_types() the rule for revision_of
-- (section 1). Each is changed only while it is still as 20261116150000 tools-04 created it (or
-- as this script did): if a later migration has changed resource_links, nothing here is changed and
-- the block says so (a developer reconciles the two), and the version blocks after it skip.
-- A produced -> publication link that exists keeps produced accepting a publication, and is listed.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_links_01() RETURNS void LANGUAGE plpgsql AS
$blk$
DECLARE
  _t       regclass := to_regclass('public.resource_links');
  _want    text[]   := ARRAY['evaluates', 'produced', 'revision_of', 'trained_on', 'was_attributed_to'];
  _fn      regprocedure := to_regprocedure('public.resource_links_check_types()');
  _ddl     text := pg_temp.kg_links_check_ddl();
  _mark    text := $m$AND _o IN ('dataset', 'software', 'tool',$m$;
  _keep    text;
  _target  text;
  _con     text;
  _have    text[];
  _live    text;
  _cstate  text;
  _fstate  text;
  _missing text;
  _npub    int;
  _pubs    text;
  _comment text := 'Curated links between two resources (KG nodes) that no column holds. predicate = a kg/bbqs.linkml.yaml slot; the exporter writes (subject, bbqs:<predicate>, object). Only evidenced links: evidence cites the record or repo statement. revision_of (20261117181500) links a published paper to its preprint, the later version to the earlier one (prov:wasRevisionOf), never both ways; public.kg_link_publication_versions() records them. A project''s papers are project_publications rows, not produced links.';
BEGIN
  IF _t IS NULL THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('resource_links', 'public.resource_links', 'skipped',
            '20261116150000_link_isolated_nodes.sql (its block tools-04) is not applied here: there is no resource_links table, so no version link can be recorded. links-02, versions-01 and versions-02 skip; the keys and indexes above do not need it. Apply 20261116150000, then run this script again.');
    RETURN;
  END IF;
  SELECT string_agg(c, ', ') INTO _missing
    FROM unnest(ARRAY['id', 'subject_id', 'predicate', 'object_id', 'basis', 'evidence']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = _t AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped);
  IF _missing IS NOT NULL THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('resource_links', 'public.resource_links', 'skipped',
            format('public.resource_links has no column(s) %s here: it is not the table 20261116150000 created. Nothing is changed; the version blocks skip.', _missing));
    RETURN;
  END IF;

  -- What is there: the CHECK's predicates, and which version of the type check.
  SELECT pg_get_constraintdef(c.oid) INTO _con
    FROM pg_constraint c WHERE c.conrelid = _t AND c.conname = 'resource_links_predicate_check' AND c.contype = 'c';
  _have := ARRAY(SELECT DISTINCT m[1] FROM regexp_matches(coalesce(_con, ''), '''([a-z_]+)''', 'g') AS m ORDER BY 1);
  _cstate := CASE WHEN _have = _want THEN 'current'
                  WHEN _have <@ _want THEN 'older'
                  WHEN 'revision_of' = ANY (_have) THEN 'later'
                  ELSE 'unknown' END;
  IF _cstate = 'older' THEN
    -- Every read and write of resource_links waits from here (ALTER TABLE takes this lock anyway),
    -- so the produced -> publication count below cannot change before the new rules are in place.
    LOCK TABLE public.resource_links IN ACCESS EXCLUSIVE MODE;
  END IF;
  SELECT count(*), string_agg(format('%s produced %s %L (%s)', l.subject_id, l.object_id, o.name, l.id), '; ' ORDER BY l.created_at, l.id)
    INTO _npub, _pubs
    FROM public.resource_links l JOIN public.resources o ON o.id = l.object_id
   WHERE l.predicate = 'produced' AND o.resource_type::text = 'publication';
  _keep := replace(_ddl, _mark, $m$AND _o IN ('publication', 'dataset', 'software', 'tool',$m$);
  IF _keep = _ddl THEN
    RAISE EXCEPTION 'links-01: the produced rule was not found in the type check text (edit of this script?)';
  END IF;
  _target := CASE WHEN _npub > 0 THEN _keep ELSE _ddl END;
  SELECT p.prosrc INTO _live FROM pg_proc p WHERE p.oid = _fn;
  _fstate := CASE WHEN _fn IS NULL THEN 'missing'
                  WHEN replace(_live, E'\r', '') = replace(pg_temp.kg_fn_body(_target), E'\r', '') THEN 'current'
                  WHEN replace(_live, E'\r', '') IN (replace(pg_temp.kg_fn_body(_ddl), E'\r', ''), replace(pg_temp.kg_fn_body(_keep), E'\r', '')) THEN 'ours'
                  WHEN md5(pg_temp.kg_norm_src(_live)) = pg_temp.kg_links_check_tools04_md5() THEN 'tools-04'
                  WHEN _live LIKE '%''revision\_of''%' THEN 'later'
                  ELSE 'unknown' END;

  IF _cstate IN ('later', 'unknown') OR _fstate IN ('later', 'unknown') THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('resource_links', 'public.resource_links', CASE WHEN pg_temp.kg_revision_of_accepted() THEN 'noop' ELSE 'skipped' END,
            format('another migration has changed resource_links since 20261116150000 (its CHECK allows %s; resource_links_check_types() is %s), so this block leaves both as they are. revision_of is %s.',
                   coalesce(nullif(array_to_string(_have, ', '), ''), 'anything (no CHECK)'),
                   CASE _fstate WHEN 'later' THEN 'a later version that handles revision_of' WHEN 'unknown' THEN 'a version this script does not know' ELSE 'as tools-04 or this script wrote it' END,
                   CASE WHEN pg_temp.kg_revision_of_accepted() THEN 'accepted: the version blocks run'
                        ELSE 'not accepted: the version blocks skip until a developer reconciles that migration with this one' END));
    RETURN;
  END IF;

  IF _cstate = 'older' THEN
    ALTER TABLE public.resource_links DROP CONSTRAINT IF EXISTS resource_links_predicate_check;
    ALTER TABLE public.resource_links ADD CONSTRAINT resource_links_predicate_check
      CHECK (predicate IN ('trained_on', 'evaluates', 'was_attributed_to', 'produced', 'revision_of'));
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('resource_links', 'resource_links_predicate_check', 'done',
            format('was %s; now %s', coalesce(_con, 'missing'),
                   pg_get_constraintdef((SELECT c.oid FROM pg_constraint c WHERE c.conrelid = _t AND c.conname = 'resource_links_predicate_check'))));
  ELSE
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('resource_links', 'resource_links_predicate_check', 'noop', 'already allows ' || array_to_string(_have, ', '));
  END IF;

  IF _fstate = 'current' THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('resource_links', 'resource_links_check_types()', 'noop',
            CASE WHEN _npub > 0 THEN 'already this script''s, with produced still accepting a publication (below)'
                 ELSE 'already this script''s: revision_of publication -> publication, never both ways; produced accepts no publication' END);
  ELSE
    EXECUTE _target;
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('resource_links', 'resource_links_check_types()', 'done',
            format('%s: revision_of links a publication to a publication, never both ways; %s',
                   CASE _fstate WHEN 'missing' THEN 'created' WHEN 'tools-04' THEN 'replaced the 20261116150000 tools-04 version' ELSE 'replaced this script''s other variant' END,
                   CASE WHEN _npub > 0 THEN 'produced still accepts a publication while the link(s) listed below exist'
                        ELSE 'produced no longer accepts a publication (one fact, one store: project_publications)' END));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = _t AND tgname = 'trg_resource_links_check_types' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_resource_links_check_types BEFORE INSERT OR UPDATE ON public.resource_links
      FOR EACH ROW EXECUTE FUNCTION public.resource_links_check_types();
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('resource_links', 'trg_resource_links_check_types', 'done', 'the type-check trigger was missing: created');
  END IF;
  IF _npub > 0 THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('resource_links', 'produced -> publication', 'skipped',
            format('%s link(s) say a project produced a paper: %s. A project''s papers are project_publications rows (the RePORTER credit): add each to project_publications if RePORTER credits it, delete the link, then run this script again, which then stops produced accepting a publication.', _npub, _pubs));
  END IF;
  IF obj_description(_t, 'pg_class') IS DISTINCT FROM _comment THEN
    EXECUTE format('COMMENT ON TABLE public.resource_links IS %L', _comment);
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('resource_links', 'table comment', 'done', 'now names revision_of and kg_link_publication_versions()');
  END IF;
END
$blk$;

-- ------------------------------------------------------------------------------------------------
-- [links-02] Create public.kg_link_publication_versions(), the pairing rule (section 1)
-- Created only where resource_links accepts revision_of (otherwise the publications importer
-- reports version links as unavailable, which is the graceful state). One that exists with another
-- body is left as it is (a later migration may have improved it): this script never downgrades it.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_links_02() RETURNS void LANGUAGE plpgsql AS
$blk$
DECLARE
  _sig  text := 'public.kg_link_publication_versions(uuid[],text,boolean,boolean)';
  _fn   regprocedure := to_regprocedure('public.kg_link_publication_versions(uuid[],text,boolean,boolean)');
  _ddl  text := pg_temp.kg_versions_ddl();
  _live text;
  _did  text[] := '{}';
  _about text := 'The preprint/published pairing rule, stated once (20261117181500_prevent_duplicates): two publications are versions of one work when both are KG nodes, their kg_title_key values are equal and at least 20 characters, exactly one is a preprint (kg_is_preprint), exactly one record of the title group is not a preprint, the preprint is not later than the published record (kg_preprint_is_later), and a project credits both (project_publications). Records resource_links (published, revision_of, preprint). _publication_ids (publications.id) limits it to their title groups; _dry returns would_link without writing; _both_listed links only a pair whose two records are both listed (the other pairs come back as would_link). Outcomes: done, noop, skipped, would_link. service_role only.';
BEGIN
  IF NOT pg_temp.kg_revision_of_accepted() THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('pairing rule', _sig, 'skipped',
            'not created: resource_links does not accept revision_of here (see links-01). import-grant-publications reports version links as unavailable until it exists.');
    RETURN;
  END IF;
  -- The draft of this script that went under review (commit b7c6044) had a three-argument version,
  -- without the order rule. Two overloads would make the importer's call ambiguous (PostgREST
  -- PGRST203), so one left behind is an error: a developer drops it, then runs this script again.
  IF to_regprocedure('public.kg_link_publication_versions(uuid[],text,boolean)') IS NOT NULL THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('pairing rule', 'public.kg_link_publication_versions(uuid[],text,boolean)', 'error',
            'a three-argument kg_link_publication_versions (a draft of this script) exists here: run  DROP FUNCTION public.kg_link_publication_versions(uuid[], text, boolean);  first. Beside the four-argument one it would make the importer''s call ambiguous (PGRST203), and it links a preprint later than its paper.');
    RETURN;
  END IF;
  IF _fn IS NULL THEN
    EXECUTE _ddl;
    _fn := to_regprocedure(_sig);
    EXECUTE format('COMMENT ON FUNCTION %s IS %L', _sig, _about);
    _did := _did || 'created'::text;
  ELSE
    SELECT p.prosrc INTO _live FROM pg_proc p WHERE p.oid = _fn;
    IF replace(_live, E'\r', '') IS DISTINCT FROM replace(pg_temp.kg_fn_body(_ddl), E'\r', '') THEN
      INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
      VALUES ('pairing rule', _sig, 'skipped',
              'exists with another body (a later migration?), so it is left as it is, with its privileges: this script never downgrades it. versions-01 and versions-02 use it as it is; compare it with this file if that is not expected.');
      RETURN;
    END IF;
    IF obj_description(_fn, 'pg_proc') IS DISTINCT FROM _about THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', _sig, _about);
      _did := _did || 'comment'::text;
    END IF;
  END IF;
  -- Supabase grants EXECUTE on every new function to anon and authenticated (default privileges):
  -- writing version links is the importer's and a curator's job, through the service role.
  IF has_function_privilege('anon', _fn, 'EXECUTE') OR has_function_privilege('authenticated', _fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
    REVOKE ALL ON FUNCTION public.kg_link_publication_versions(uuid[], text, boolean, boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.kg_link_publication_versions(uuid[], text, boolean, boolean) TO service_role;
    _did := _did || 'EXECUTE for service_role only'::text;
  END IF;
  IF cardinality(_did) > 0 THEN
    PERFORM pg_notify('pgrst', 'reload schema');   -- PostgREST sees the RPC now (sent at COMMIT only)
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('pairing rule', _sig, 'done', array_to_string(_did, ', ') || '; anon and authenticated may not call it');
  ELSE
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('pairing rule', _sig, 'noop', 'already present with this body; EXECUTE for service_role only');
  END IF;
END
$blk$;

-- ------------------------------------------------------------------------------------------------
-- [versions-01] Link the 5 preprint/published pairs of the 2026-11-17 export
-- Each of the 10 PMIDs must name exactly one publication row (by its key), else its pair is
-- skipped. Then ONE call of the pairing rule decides, for the title groups of those rows, with
-- _both_listed: it links a pair only when both its records are among the 10 (basis curator_fill: a
-- curator read these 5 pairs, and only these). One decision is written per expected pair. Any other
-- pair the rule finds in those title groups is listed as would_link and NOT linked: nobody read it,
-- so curator_fill would be a false claim (versions-02 says how to link it).
CREATE OR REPLACE FUNCTION pg_temp.kg_b_versions_01() RETURNS void LANGUAGE plpgsql AS
$blk$
DECLARE
  e     record;
  r     record;
  _ids  uuid[] := '{}';
  _seen text[] := '{}';
  _lab  text;
BEGIN
  IF to_regprocedure('public.kg_link_publication_versions(uuid[],text,boolean,boolean)') IS NULL OR NOT pg_temp.kg_revision_of_accepted() THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    SELECT 'version link', format('%s: PMID %s revision_of preprint PMID %s (%s)', k.label, k.published_pmid, k.preprint_pmid, k.grant_number),
           'skipped', 'resource_links does not accept revision_of here, or kg_link_publication_versions() is missing (see links-01, links-02): nothing is linked'
      FROM pg_temp.kg_known_versions() k ORDER BY k.ord;
    RETURN;
  END IF;
  FOR e IN
    SELECT k.*,
           ARRAY(SELECT p.id FROM public.publications p WHERE public.kg_pmid_key(p.pmid) = k.published_pmid ORDER BY p.id) AS a,
           ARRAY(SELECT p.id FROM public.publications p WHERE public.kg_pmid_key(p.pmid) = k.preprint_pmid ORDER BY p.id) AS b
      FROM pg_temp.kg_known_versions() k ORDER BY k.ord
  LOOP
    IF cardinality(e.a) = 1 AND cardinality(e.b) = 1 THEN
      _ids := _ids || e.a || e.b;
    ELSE
      _seen := _seen || e.label;
      INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
      VALUES ('version link', format('%s: PMID %s revision_of preprint PMID %s (%s)', e.label, e.published_pmid, e.preprint_pmid, e.grant_number), 'skipped',
              format('PMID %s names %s publication row(s) and PMID %s names %s; each must be exactly one. A missing paper is imported by import-grant-publications; two rows are a duplicate to merge (see index-03). Then run this script again.',
                     e.published_pmid, cardinality(e.a), e.preprint_pmid, cardinality(e.b)));
    END IF;
  END LOOP;
  IF cardinality(_ids) = 0 THEN
    RETURN;
  END IF;

  FOR r IN SELECT * FROM public.kg_link_publication_versions(_ids, 'curator_fill', false, true) LOOP
    SELECT format('%s: PMID %s revision_of preprint PMID %s (%s)', k.label, k.published_pmid, k.preprint_pmid, k.grant_number)
      INTO _lab
      FROM pg_temp.kg_known_versions() k
      JOIN public.publications pa ON public.kg_pmid_key(pa.pmid) = k.published_pmid AND pa.resource_id = r.subject_id
      JOIN public.publications pb ON public.kg_pmid_key(pb.pmid) = k.preprint_pmid AND pb.resource_id = r.object_id
     ORDER BY k.ord LIMIT 1;
    IF _lab IS NOT NULL THEN
      _seen := _seen || split_part(_lab, ':', 1);
    END IF;
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('version link', coalesce(_lab, format('not one of the 5 pairs, in their title groups: %s revision_of %s', r.subject_id, r.object_id)),
            CASE WHEN _lab IS NOT NULL AND r.outcome IN ('done', 'noop', 'skipped') THEN r.outcome ELSE 'report' END,
            r.detail || CASE WHEN _lab IS NULL AND r.outcome = 'would_link'
                             THEN '. Not linked here: this block links the 5 pairs a curator read (curator_fill) and no other; versions-02 says how to link this one'
                             ELSE '' END);
  END LOOP;

  FOR e IN
    SELECT k.*,
           (SELECT min(p.id::text)::uuid FROM public.publications p WHERE public.kg_pmid_key(p.pmid) = k.published_pmid) AS a,
           (SELECT min(p.id::text)::uuid FROM public.publications p WHERE public.kg_pmid_key(p.pmid) = k.preprint_pmid) AS b
      FROM pg_temp.kg_known_versions() k
     WHERE NOT k.label = ANY (_seen)
     ORDER BY k.ord
  LOOP
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('version link', format('%s: PMID %s revision_of preprint PMID %s (%s)', e.label, e.published_pmid, e.preprint_pmid, e.grant_number), 'skipped',
            'the pairing rule does not pair them: ' || pg_temp.kg_why_not_paired(e.a, e.b) || '. Nothing is linked; a curator checks the two records.');
  END LOOP;
END
$blk$;

-- ------------------------------------------------------------------------------------------------
-- [versions-02] Any other pair the rule finds (read-only: a dry call of the pairing rule)
-- 'would_link' is a pair not linked yet: import-grant-publications links it (basis 'algorithmic')
-- if it imports that project's papers again, or a curator who has read the two records links it
-- (basis 'curator_fill', named with set_actor); 'skipped' is a near-pair and why it is not one.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_versions_02() RETURNS void LANGUAGE plpgsql AS
$blk$
DECLARE
  r      record;
  _noop  int := 0;
  _other int := 0;
BEGIN
  IF to_regprocedure('public.kg_link_publication_versions(uuid[],text,boolean,boolean)') IS NULL OR NOT pg_temp.kg_revision_of_accepted() THEN
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('other pairs', 'kg_link_publication_versions(NULL, ''algorithmic'', true)', 'skipped',
            'resource_links does not accept revision_of here, or the function is missing: nothing to look for');
    RETURN;
  END IF;
  FOR r IN SELECT * FROM public.kg_link_publication_versions(NULL, 'algorithmic', true) LOOP
    IF r.outcome = 'noop' THEN
      _noop := _noop + 1;
      CONTINUE;
    END IF;
    _other := _other + 1;
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('other pair (' || r.outcome || ')', format('%s revision_of %s', r.subject_id, r.object_id), 'report',
            r.detail || CASE WHEN r.outcome = 'would_link'
                             THEN format('. Not linked yet. import-grant-publications links it if it imports that project''s papers again (it runs only when invoked: 20260831140000 leaves its weekly schedule commented out). Or a curator who has read the two records links it in the SQL editor, named:  SELECT public.set_actor(''curator:<name>'');  SELECT * FROM public.kg_link_publication_versions(ARRAY(SELECT id FROM public.publications WHERE resource_id IN (%L, %L)), ''curator_fill'', false, true);',
                                         r.subject_id, r.object_id)
                             ELSE '' END);
  END LOOP;
  INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
  VALUES ('other pairs', 'every publication', 'report',
          format('%s pair(s) linked; %s other pair(s) or near-pair(s) listed above', _noop, _other));
END
$blk$;

-- ------------------------------------------------------------------------------------------------
-- [orphans-01] What still keeps a person or an organization from being one node (read-only)
-- No database rule prevents an orphan investigator spine row this round (a person deleted and the
-- spine row left; or the spine row written and the person insert failed): the write paths now
-- insert the person first, and this block lists what is left on every run.
CREATE OR REPLACE FUNCTION pg_temp.kg_b_orphans_01() RETURNS void LANGUAGE plpgsql AS
$blk$
DECLARE
  _n    bigint;
  _list text;
  t     record;
BEGIN
  SELECT count(*), string_agg(format('%s %L', x.id, x.name), '; ' ORDER BY x.name) FILTER (WHERE x.rn <= 50)
    INTO _n, _list
    FROM (SELECT r.id, r.name, row_number() OVER (ORDER BY r.name, r.id) AS rn
            FROM public.resources r
           WHERE r.resource_type::text = 'investigator'
             AND NOT EXISTS (SELECT 1 FROM public.investigators i WHERE i.resource_id = r.id)) x;
  INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
  VALUES ('orphan spine rows', 'investigator', 'report',
          CASE WHEN _n = 0 THEN 'none: every investigator node has its person row'
               ELSE format('%s investigator node(s) that no person row points at (20261116150000 people-01 deleted 14 such): %s%s. The real person is usually a twin (double spaces, RePORTER capitals): a curator merges by hand.',
                           _n, _list, CASE WHEN _n > 50 THEN '; ...' ELSE '' END) END);

  SELECT count(*), string_agg(format('%L', x.name), ', ' ORDER BY x.name) FILTER (WHERE x.rn <= 50)
    INTO _n, _list
    FROM (SELECT i.name, row_number() OVER (ORDER BY i.name) AS rn FROM public.investigators i WHERE i.resource_id IS NULL) x;
  INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
  VALUES ('people with no node', 'investigators.resource_id IS NULL', 'report',
          CASE WHEN _n = 0 THEN 'none'
               ELSE format('%s person row(s) with no spine row, so not in the KG (an onboarding visibility decision, not a duplicate): %s%s', _n, _list, CASE WHEN _n > 50 THEN ', ...' ELSE '' END) END);

  SELECT count(*), string_agg(format('%L (node %L)', x.pname, x.rname), '; ' ORDER BY x.pname) FILTER (WHERE x.rn <= 50)
    INTO _n, _list
    FROM (SELECT i.name AS pname, r.name AS rname, row_number() OVER (ORDER BY i.name) AS rn
            FROM public.investigators i JOIN public.resources r ON r.id = i.resource_id
           WHERE public.kg_name_key(i.name) IS DISTINCT FROM public.kg_name_key(r.name)) x;
  INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
  VALUES ('name drift', 'person vs spine row', 'report',
          CASE WHEN _n = 0 THEN 'none: every person is named as its node is (by name key)'
               ELSE format('%s person(s) named otherwise than their node: %s%s', _n, _list, CASE WHEN _n > 50 THEN '; ...' ELSE '' END) END);

  FOR t IN
    SELECT * FROM (VALUES (1, 'publication', 'publications'), (2, 'organization', 'organizations'),
                          (3, 'grant', 'grants'), (4, 'funding', 'funding_opportunities')) AS v(n, rtype, tbl)
     ORDER BY 1
  LOOP
    EXECUTE format(
      'SELECT count(*), string_agg(format(''%%s %%L'', x.id, x.name), ''; '' ORDER BY x.name) FILTER (WHERE x.rn <= 20)
         FROM (SELECT r.id, r.name, row_number() OVER (ORDER BY r.name, r.id) AS rn
                 FROM public.resources r
                WHERE r.resource_type::text = %L
                  AND NOT EXISTS (SELECT 1 FROM public.%I d WHERE d.resource_id = r.id)
                  %s) x',
      t.rtype, t.tbl,
      CASE WHEN t.rtype = 'grant' THEN 'AND NOT EXISTS (SELECT 1 FROM public.projects pj WHERE pj.resource_id = r.id)' ELSE '' END)
      INTO _n, _list;
    INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
    VALUES ('orphan spine rows', t.rtype, 'report',
            CASE WHEN _n = 0 THEN format('none: every %s node has its %s row', t.rtype, t.tbl)
                 ELSE format('%s %s node(s) with no %s row: %s%s', _n, t.rtype, t.tbl, _list, CASE WHEN _n > 20 THEN '; ...' ELSE '' END) END);
  END LOOP;

  SELECT count(*), string_agg(format('%L (node %L)', x.oname, x.rname), '; ' ORDER BY x.oname) FILTER (WHERE x.rn <= 50)
    INTO _n, _list
    FROM (SELECT o.name AS oname, r.name AS rname, row_number() OVER (ORDER BY o.name) AS rn
            FROM public.organizations o JOIN public.resources r ON r.id = o.resource_id
           WHERE public.kg_name_key(o.name) IS DISTINCT FROM public.kg_name_key(r.name)) x;
  INSERT INTO pg_temp.kg_fix_report (item, target, outcome, detail)
  VALUES ('name drift', 'organization vs spine row', 'report',
          CASE WHEN _n = 0 THEN 'none: every organization is named as its node is (by name key)'
               ELSE format('%s organization(s) named otherwise than their node: %s%s', _n, _list, CASE WHEN _n > 50 THEN '; ...' ELSE '' END) END);
END
$blk$;

-- ================================================================================================
-- 3. RUN. One DO block runs every block above in order, inside one savepoint:
--    * dry run ('on'): at the end the savepoint is rolled back (every write, the DDL included), and
--      the report rows are put back, so the editor still shows them;
--    * real run ('off'): committed below, unless any block reported an error: then NOTHING is
--      changed and the editor shows the errors.
-- ================================================================================================
DO $kg$
DECLARE
  kg_dry  constant boolean := coalesce(current_setting('bbqs.dry_run', true), 'on') IS DISTINCT FROM 'off';
  kg_keep pg_temp.kg_fix_report[];
  kg_errs int := 0;
  kg_list text;
BEGIN
  BEGIN
    PERFORM pg_temp.kg_run(1, 'keys-01', 'Create the identity-key functions public.kg_*_key, kg_title_key, kg_is_preprint and kg_preprint_is_later where missing', 'pg_temp.kg_b_keys_01');
    PERFORM pg_temp.kg_run(2, 'keys-02', 'Self-test: this database computes the 97 SQL vectors of kg/identity_keys.json', 'pg_temp.kg_b_keys_02');
    PERFORM pg_temp.kg_run(3, 'index-01', 'One person per ORCID iD: uq_investigators_orcid_key', 'pg_temp.kg_b_index_01');
    PERFORM pg_temp.kg_run(4, 'index-02', 'One publication per DOI: uq_publications_doi_key', 'pg_temp.kg_b_index_02');
    PERFORM pg_temp.kg_run(5, 'index-03', 'One publication per PMID: uq_publications_pmid_key', 'pg_temp.kg_b_index_03');
    PERFORM pg_temp.kg_run(6, 'index-04', 'One organization per name key: uq_organizations_name_key', 'pg_temp.kg_b_index_04');
    PERFORM pg_temp.kg_run(7, 'index-05', 'One grant per award: uq_grants_award_key', 'pg_temp.kg_b_index_05');
    PERFORM pg_temp.kg_run(8, 'index-06', 'One project per award: uq_projects_award_key', 'pg_temp.kg_b_index_06');
    PERFORM pg_temp.kg_run(9, 'index-07', 'One funding call per FON key: uq_funding_opportunities_fon_key', 'pg_temp.kg_b_index_07');
    PERFORM pg_temp.kg_run(10, 'nodes-01', 'One detail row per KG node: uq_<table>_resource_id on the 13 node tables', 'pg_temp.kg_b_nodes_01');
    PERFORM pg_temp.kg_run(11, 'links-01', 'resource_links accepts revision_of (publication -> publication); produced no longer accepts a publication', 'pg_temp.kg_b_links_01');
    PERFORM pg_temp.kg_run(12, 'links-02', 'Create public.kg_link_publication_versions(), the pairing rule (service_role only)', 'pg_temp.kg_b_links_02');
    PERFORM pg_temp.kg_run(13, 'versions-01', 'Link the 5 preprint/published pairs of the 2026-11-17 export (revision_of), and only them', 'pg_temp.kg_b_versions_01');
    -- read-only reports, last, so they describe the end state
    PERFORM pg_temp.kg_run(14, 'versions-02', 'Any other pair the rule finds (read-only; how to link each)', 'pg_temp.kg_b_versions_02');
    PERFORM pg_temp.kg_run(15, 'orphans-01', 'Orphan spine rows, people with no node, name drift (read-only)', 'pg_temp.kg_b_orphans_01');

    SELECT count(*) INTO kg_errs FROM pg_temp.kg_fix_report WHERE kind = 'decision' AND outcome = 'error';
    IF kg_dry OR kg_errs > 0 THEN
      SELECT array_agg(r ORDER BY r.seq) INTO kg_keep FROM pg_temp.kg_fix_report r;
      RAISE EXCEPTION USING ERRCODE = 'KG000', MESSAGE = 'prevent_duplicates: rolling the run back';
    END IF;
  EXCEPTION WHEN SQLSTATE 'KG000' THEN
    -- Every write above is undone at this point (the DDL too); only the report survives (copied first).
    INSERT INTO pg_temp.kg_fix_report SELECT * FROM unnest(kg_keep);
  END;
  PERFORM public.set_actor('migration:prevent_duplicates');
  IF NOT kg_dry AND kg_errs > 0 THEN
    SELECT string_agg(format('[%s] %s | %s | %s', r.block, r.item, coalesce(r.target, ''), r.detail), E'\n' ORDER BY r.seq)
      INTO kg_list FROM pg_temp.kg_fix_report r WHERE r.kind = 'decision' AND r.outcome = 'error';
    RAISE EXCEPTION E'prevent_duplicates: NOTHING WAS CHANGED, % error(s):\n%', kg_errs, kg_list
      USING HINT = 'Set the dry-run switch back to ''on'' and run again to see the whole report; fix the cause, or comment out that block''s line in section 3.';
  END IF;
  PERFORM pg_temp.kg_result(kg_dry);
END
$kg$;

COMMIT;

-- The report (the editor shows only this last result): RESULT, then one summary row per block
-- (rows = rows written), then every decision. In a dry run it shows what WOULD be written.
SELECT * FROM pg_temp.kg_report();
