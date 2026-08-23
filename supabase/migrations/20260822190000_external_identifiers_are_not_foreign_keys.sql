-- Not every column ending in _id is a foreign key. Two are external identifiers, and I excluded them.
--
-- THE MISTAKE. 20260822160000 stopped grading foreign keys by SHAPE, matching `_id$`, on the
-- reasoning that foreign keys are added constantly and a hand-maintained list would always be
-- behind. That reasoning still holds. What I did next was check the rule against `orcid`, `pmid` and
-- `doi` -- the three names I happened to think of -- confirm they were safe, and ship it.
--
-- I never enumerated what the rule actually caught. Doing that afterwards, across all 30 `_id$`
-- columns in the store, finds two that are not foreign keys at all:
--
--   investigators.scholar_id          a Google Scholar profile id. An external identifier: it points
--                                     OUT of this database, at a public page anyone can open. That
--                                     is a checkable claim about a person, which is the whole test.
--   resources.metadata.dandiset_id    a DANDI accession. Same shape of thing -- resolvable at
--                                     dandiarchive.org, and the reason a resource can be verified.
--
-- Both were silently ungraded: no error, no empty state, just a value on screen with no chip beside
-- it, indistinguishable from "this viewer isn't staff". Caught by a guard asserting that every field
-- wired to a chip is a field the system will actually grade -- not by looking at the database.
--
-- DELIBERATELY STILL EXCLUDED:
--   projects.metadata.questionnaire_response_id   a Google Form response id. It records HOW the
--     value arrived, which is provenance bookkeeping, not a claim about the project.
--   dandisets.dandiset_id                          real content, but `dandisets` is an excluded
--     table -- a mirror of an external system, where the truth lives upstream.
--   the other 26                                   genuine foreign keys.
--
-- THE RULE FOR NEXT TIME, since this is the second correction to the same shape-based rule: a
-- pattern that excludes by NAME must be run against the actual column inventory before shipping, not
-- against a few examples recalled from memory. The inventory is one query.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260822190000');

-- ── 1. Name the exceptions ──────────────────────────────────────────────────────────────────
/** Columns ending in _id that are EXTERNAL identifiers rather than foreign keys.
 *
 *  The test is which direction the identifier points. A foreign key points INTO this database and
 *  is the identity of a relationship -- nothing a person can check. An external identifier points
 *  OUT, at a registry or page someone can open, which makes it exactly the kind of claim this
 *  system exists to grade.
 *
 *  This list is short on purpose. If it grows past a handful, the shape-based rule is wrong and
 *  should be replaced by reading pg_constraint for actual foreign keys. */
CREATE OR REPLACE FUNCTION public.provenance_external_identifier_columns()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    'scholar_id',     -- investigators: Google Scholar profile
    'dandiset_id'     -- resources.metadata: DANDI accession, resolvable at dandiarchive.org
  ]::text[]
$fn$;

COMMENT ON FUNCTION public.provenance_external_identifier_columns() IS
  'Columns ending in _id that are external identifiers, not foreign keys, and so ARE graded. The distinction is which way the identifier points: a foreign key points into this database and is the identity of a relationship; an external identifier points out at something a person can open and check.';

GRANT EXECUTE ON FUNCTION public.provenance_external_identifier_columns() TO authenticated, service_role;

-- ── 2. Teach the gradability rule about them ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provenance_is_gradable_column(_col text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT NOT (split_part(_col, '.', 1) = ANY (public.provenance_excluded_columns()))
     AND (
       -- not foreign-key shaped, OR named as an external identifier
       _col !~ '_id$'
       OR split_part(_col, '.', 2) = ANY (public.provenance_external_identifier_columns())
       OR split_part(_col, '.', 1) = ANY (public.provenance_external_identifier_columns())
     )
$fn$;

COMMENT ON FUNCTION public.provenance_is_gradable_column(text) IS
  'Whether a cell deserves a provenance claim. Excludes bookkeeping columns by name and foreign keys by shape (_id$), with named exceptions for external identifiers -- scholar_id and metadata.dandiset_id point OUT of this database at something checkable, so they are claims. The pattern is a regex, not LIKE: in LIKE the underscore is a wildcard, so ''%_id'' would also have excluded orcid.';

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) The two exceptions are gradable again; real foreign keys still are not.
SELECT public.provenance_is_gradable_column('scholar_id')           AS scholar_expect_true,
       public.provenance_is_gradable_column('metadata.dandiset_id') AS dandiset_expect_true,
       public.provenance_is_gradable_column('investigator_id')      AS fk_expect_false,
       public.provenance_is_gradable_column('grant_id')             AS fk2_expect_false,
       public.provenance_is_gradable_column('resource_id')          AS fk3_expect_false,
       public.provenance_is_gradable_column('orcid')                AS orcid_expect_true,
       public.provenance_is_gradable_column('reminder_count')       AS bookkeeping_expect_false;

-- 2) They reappear in coverage: +2 cells on investigators, +17 on resources.
SELECT table_name, cells, verified, pct_verified
  FROM public.provenance_coverage
 WHERE table_name IN ('investigators', 'resources') ORDER BY table_name;

-- 3) And nothing else came back with them. Expect ONLY scholar_id and metadata.dandiset_id.
SELECT DISTINCT entity_table, entity_column
  FROM public.provenance_worklist
 WHERE entity_column ~ '_id$'
 ORDER BY entity_table, entity_column;

-- 4) The full inventory of _id$ columns and whether each is now graded -- the check I should have
--    run before shipping the shape-based rule in the first place.
SELECT DISTINCT fp.entity_table, fp.entity_column,
       public.provenance_is_gradable_column(fp.entity_column) AS graded
  FROM public.field_provenance fp
 WHERE fp.entity_column ~ '_id$'
 ORDER BY graded DESC, fp.entity_table, fp.entity_column;
