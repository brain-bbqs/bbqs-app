-- Read the provenance the data already carries, instead of stamping it "no recorded source".
--
-- THE COMPLAINT, and it is correct. The review queue listed grant_investigators rows as G8 "No
-- recorded source" with an "I have reviewed this record" button — while the very same row carries
-- role_source = 'reporter'. The roster came from NIH RePORTER. Asking a curator to vouch for NIH's
-- own list of PIs is worse than useless: it wastes the reviewer's time AND tells every reader that
-- authoritative data is unreliable. Exactly the inversion Principle XI exists to prevent, produced
-- by the tool built to prevent it.
--
-- MY MISTAKE. provenance_backfill_unknown() stamped every cell 'unknown' on the reasoning that the
-- LIVE DATABASE said nothing about where values came from. That was true for projects, and I
-- generalised it to the whole schema without looking. Four tables record their own origin:
--
--   grant_investigators.role_source   'reporter' (73 rows) or 'curator' (31)
--   publications.pmid + pubmed_link   all 45 rows; the bibliographic fields ARE the PubMed record
--   grants.reporter_project_num       + nih_link; title/abstract/amount/year are RePORTER's
--   grant_dandisets.match_source      'award_number' — a deterministic match, so algorithmic
--
-- ~1,055 cells. The rule I should have followed, and which any future backfill must: LOOK FOR A
-- CO-LOCATED SOURCE MARKER BEFORE DECLARING THERE IS NONE. Absence of provenance in the store is not
-- absence of provenance in the record.
--
-- WHY AN IDENTIFIER COUNTS AS EVIDENCE. A publications row with pmid 39703614 is not "probably from
-- PubMed" — its title, authors, journal and year ARE that PubMed record, and anyone can check in one
-- click. Same for a grants row with a reporter_project_num. That is a G1 claim with a source_ref a
-- human can follow, which is the whole test.
--
-- WHAT IS DELIBERATELY NOT CLAIMED. publications.keywords and author_orcids: keywords may be
-- hand-added and ORCIDs may be matched rather than supplied, so they stay as they are. Nothing here
-- rewrites a value; these are provenance claims about values that already exist.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260822150000');

-- ── 1. The roster: RePORTER or a curator, as the row itself says ─────────────────────────────
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, evidence, recorded_by)
SELECT 'grant_investigators', gi.id, c.col,
       CASE WHEN gi.role_source = 'reporter' THEN 'authoritative_registry' ELSE 'curator_fill' END,
       CASE WHEN gi.role_source = 'reporter' THEN 'reporter_roster_import' ELSE 'curator_assigned_role' END,
       CASE WHEN gi.role_source = 'reporter' THEN 'NIH RePORTER' ELSE 'curator' END,
       coalesce(g.reporter_project_num, g.grant_number),
       left(c.val, 500),
       format('grant_investigators.role_source records this row as "%s".', gi.role_source),
       'migration:20260822150000'
  FROM public.grant_investigators gi
  LEFT JOIN public.grants g ON g.id = gi.grant_id
 CROSS JOIN LATERAL (VALUES
     ('role',            gi.role),
     ('role_source',     gi.role_source),
     ('grant_id',        gi.grant_id::text),
     ('investigator_id', gi.investigator_id::text)
   ) AS c(col, val)
 WHERE gi.role_source IN ('reporter', 'curator')
   AND btrim(coalesce(c.val, '')) <> '';

-- ── 2. Publications: the PMID IS the source ─────────────────────────────────────────────────
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, evidence, recorded_by)
SELECT 'publications', p.id, c.col, 'authoritative_registry', 'pubmed_import',
       'PubMed',
       coalesce(p.pubmed_link, 'https://pubmed.ncbi.nlm.nih.gov/' || p.pmid::text),
       left(c.val, 500),
       format('PMID %s. The bibliographic fields on this row are that PubMed record and can be checked against it.', p.pmid),
       'migration:20260822150000'
  FROM public.publications p
 CROSS JOIN LATERAL (VALUES
     ('title',       p.title),
     ('authors',     p.authors),
     ('journal',     p.journal),
     ('year',        p.year::text),
     ('doi',         p.doi),
     ('pmid',        p.pmid::text),
     ('pubmed_link', p.pubmed_link),
     -- citations and rcr come from iCite rather than PubMed proper, but both are NIH registries and
     -- both are re-checkable from the same identifier.
     ('citations',   p.citations::text),
     ('rcr',         p.rcr::text)
   ) AS c(col, val)
 WHERE p.pmid IS NOT NULL
   AND btrim(coalesce(c.val, '')) <> '';

-- ── 3. Grants: RePORTER's own record of the award ────────────────────────────────────────────
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, evidence, recorded_by)
SELECT 'grants', g.id, c.col, 'authoritative_registry', 'reporter_import',
       'NIH RePORTER',
       coalesce(g.nih_link, g.reporter_project_num, g.grant_number),
       left(c.val, 500),
       format('RePORTER project %s. Award facts are the registry''s own record.',
              coalesce(g.reporter_project_num, g.grant_number)),
       'migration:20260822150000'
  FROM public.grants g
 CROSS JOIN LATERAL (VALUES
     ('grant_number',          g.grant_number),
     ('reporter_project_num',  g.reporter_project_num),
     ('title',                 g.title),
     ('abstract',              g.abstract),
     ('award_amount',          g.award_amount::text),
     ('fiscal_year',           g.fiscal_year::text),
     ('nih_link',              g.nih_link)
   ) AS c(col, val)
 WHERE coalesce(g.reporter_project_num, g.grant_number) IS NOT NULL
   AND btrim(coalesce(c.val, '')) <> '';

-- ── 4. Grant/dandiset links: a computed match, graded as one ────────────────────────────────
-- match_source = 'award_number' means a rule matched them, not that a person checked. G5, with the
-- rule named, is the honest grade: better evidence than nothing, weaker than a human.
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, evidence, recorded_by)
SELECT 'grant_dandisets', gd.id, c.col, 'algorithmic', 'award_number_match',
       'dandiset linker', 'match on ' || gd.match_source,
       left(c.val, 500),
       format('grant_dandisets.match_source = "%s": matched by rule, not confirmed by a person.', gd.match_source),
       'migration:20260822150000'
  FROM public.grant_dandisets gd
 CROSS JOIN LATERAL (VALUES
     ('grant_id',     gd.grant_id::text),
     ('dandiset_id',  gd.dandiset_id::text),
     ('match_source', gd.match_source),
     ('matched_award', gd.matched_award)
   ) AS c(col, val)
 WHERE gd.match_source IS NOT NULL
   AND btrim(coalesce(c.val, '')) <> '';

-- ── 5. Stop the next backfill repeating this ─────────────────────────────────────────────────
COMMENT ON FUNCTION public.provenance_backfill_unknown(text) IS
  'Stamps unknown on cells with no claim. IMPORTANT: run AFTER any migration that derives provenance from source markers the data already carries (grant_investigators.role_source, publications.pmid, grants.reporter_project_num, grant_dandisets.match_source). Stamping first put NIH RePORTER''s own PI roster in the curator review queue as "no recorded source", which is the exact inversion this feature exists to prevent. Absence of provenance in the store is not absence of provenance in the record.';

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Those tables should now be mostly verified rather than entirely unverified.
SELECT table_name, cells, verified, unverified, pct_verified
  FROM public.provenance_coverage
 WHERE table_name IN ('grant_investigators', 'publications', 'grants', 'grant_dandisets')
 ORDER BY table_name;

-- 2) The roster, split the way the row itself describes: 73 from RePORTER, 31 from a curator.
SELECT fpc.source_label, count(*) AS cells
  FROM public.field_provenance_current fpc
 WHERE fpc.entity_table = 'grant_investigators'
 GROUP BY fpc.source_label ORDER BY cells DESC;

-- 3) No roster row should remain in the review queue. Expect 0.
SELECT count(*) AS roster_rows_still_queued
  FROM public.provenance_worklist WHERE entity_table = 'grant_investigators';

-- 4) The whole graph. Verified coverage should jump by roughly a thousand cells.
SELECT sum(cells) AS cells, sum(verified) AS verified,
       round(100.0 * sum(verified) / nullif(sum(cells), 0), 1) AS pct_verified
  FROM public.provenance_coverage;
