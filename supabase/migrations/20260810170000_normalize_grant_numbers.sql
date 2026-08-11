-- Normalize grant_number to the STABLE CORE (activity code + institute + serial).
--
-- DECISION (2026-08-10): "let's normalize to the stable core".
--
-- The ask began as "make grant_number exactly what RePORTER returns", but RePORTER's project_num is
-- NOT stable — its leading digit is the APPLICATION TYPE and its suffix is the SUPPORT YEAR, so the
-- same award reports differently every fiscal year:
--
--   R34DA059506    FY2024 = 1R34DA059506-01   FY2025 = 5R34DA059506-02
--   R61MH135106    FY2024 = 1R61MH135106-01   FY2025 = 5R61MH135106-02   FY2026 = 7R61MH135106-03
--
-- Verified across all 31 grants: 57 RePORTER records, and every multi-year award changes its
-- project_num annually. Pinning grant_number to that string would mean rewriting this column and its
-- eight referencing tables every year, and 1U01MH144347-01 would become 5U01MH144347-02 next year.
--
-- The core is the identifier that does not move. It is also what 25 of the 31 rows already used, and
-- what both repos' lookup code already strips to before matching
-- (replace(/^\d+/,'').replace(/-\d+[A-Z0-9]*$/,'') in read-tools.ts, import.server.ts and
-- add-project-by-grant). Normalizing here makes the stored value agree with the code instead of
-- being repaired at every call site.
--
-- BEFORE: 25 bare core, 6 type-prefixed (1R61MH138967), 1 with a support-year suffix
-- (1U01MH144347-01). AFTER: 31 bare core.
--
-- BLAST RADIUS. grant_number is a TEXT foreign key, not a real FK, so nothing cascades and every
-- copy must be rewritten in the same transaction or the joins silently return nothing. All nine
-- columns are updated below. Full-award numbers remain resolvable: RePORTER keeps them, and
-- reporter_project_num (added here) records the live one per grant.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260810170000');

BEGIN;

-- The live RePORTER string, so nothing is lost by shortening grant_number. The importer should
-- refresh this whenever it syncs a grant; it changes each fiscal year by design.
ALTER TABLE public.grants ADD COLUMN IF NOT EXISTS reporter_project_num text;

COMMENT ON COLUMN public.grants.reporter_project_num IS
  'The full NIH RePORTER project_num for the most recent fiscal year (e.g. 5R34DA059506-02). Changes annually -- leading digit is the application type, suffix the support year. grant_number holds the STABLE core; join on that, display this.';

COMMENT ON COLUMN public.grants.grant_number IS
  'Stable award core: activity code + institute + serial (e.g. R34DA059506). Deliberately WITHOUT the application-type prefix and support-year suffix, which RePORTER changes every fiscal year. See reporter_project_num for the current full string.';

-- Record the full form we currently hold, before shortening it.
UPDATE public.grants
   SET reporter_project_num = coalesce(reporter_project_num, grant_number)
 WHERE grant_number ~ '^[0-9]' OR grant_number ~ '-[0-9]';


-- 6 grant_number values to normalize.
-- Rewrite every copy in one transaction. Order does not matter (no real FKs), but all
-- must land together or cross-table joins on grant_number break.

--   1R61MH138612 -> R61MH138612
UPDATE public.grants SET grant_number = 'R61MH138612' WHERE grant_number = '1R61MH138612';
UPDATE public.projects SET grant_number = 'R61MH138612' WHERE grant_number = '1R61MH138612';
UPDATE public.curation_audit_log SET grant_number = 'R61MH138612' WHERE grant_number = '1R61MH138612';
UPDATE public.edit_history SET grant_number = 'R61MH138612' WHERE grant_number = '1R61MH138612';
UPDATE public.project_device_usage SET grant_number = 'R61MH138612' WHERE grant_number = '1R61MH138612';
UPDATE public.grant_methods_evidence SET seed_grant_number = 'R61MH138612' WHERE seed_grant_number = '1R61MH138612';
UPDATE public.grant_methods_evidence SET source_grant_number = 'R61MH138612' WHERE source_grant_number = '1R61MH138612';
UPDATE public.grant_methods_traversal_paths SET seed_grant_number = 'R61MH138612' WHERE seed_grant_number = '1R61MH138612';
UPDATE public.proposed_relations SET seed_grant_number = 'R61MH138612' WHERE seed_grant_number = '1R61MH138612';

--   1R61MH138967 -> R61MH138967
UPDATE public.grants SET grant_number = 'R61MH138967' WHERE grant_number = '1R61MH138967';
UPDATE public.projects SET grant_number = 'R61MH138967' WHERE grant_number = '1R61MH138967';
UPDATE public.curation_audit_log SET grant_number = 'R61MH138967' WHERE grant_number = '1R61MH138967';
UPDATE public.edit_history SET grant_number = 'R61MH138967' WHERE grant_number = '1R61MH138967';
UPDATE public.project_device_usage SET grant_number = 'R61MH138967' WHERE grant_number = '1R61MH138967';
UPDATE public.grant_methods_evidence SET seed_grant_number = 'R61MH138967' WHERE seed_grant_number = '1R61MH138967';
UPDATE public.grant_methods_evidence SET source_grant_number = 'R61MH138967' WHERE source_grant_number = '1R61MH138967';
UPDATE public.grant_methods_traversal_paths SET seed_grant_number = 'R61MH138967' WHERE seed_grant_number = '1R61MH138967';
UPDATE public.proposed_relations SET seed_grant_number = 'R61MH138967' WHERE seed_grant_number = '1R61MH138967';

--   1U01DA063534 -> U01DA063534
UPDATE public.grants SET grant_number = 'U01DA063534' WHERE grant_number = '1U01DA063534';
UPDATE public.projects SET grant_number = 'U01DA063534' WHERE grant_number = '1U01DA063534';
UPDATE public.curation_audit_log SET grant_number = 'U01DA063534' WHERE grant_number = '1U01DA063534';
UPDATE public.edit_history SET grant_number = 'U01DA063534' WHERE grant_number = '1U01DA063534';
UPDATE public.project_device_usage SET grant_number = 'U01DA063534' WHERE grant_number = '1U01DA063534';
UPDATE public.grant_methods_evidence SET seed_grant_number = 'U01DA063534' WHERE seed_grant_number = '1U01DA063534';
UPDATE public.grant_methods_evidence SET source_grant_number = 'U01DA063534' WHERE source_grant_number = '1U01DA063534';
UPDATE public.grant_methods_traversal_paths SET seed_grant_number = 'U01DA063534' WHERE seed_grant_number = '1U01DA063534';
UPDATE public.proposed_relations SET seed_grant_number = 'U01DA063534' WHERE seed_grant_number = '1U01DA063534';

--   1U01DA063565 -> U01DA063565
UPDATE public.grants SET grant_number = 'U01DA063565' WHERE grant_number = '1U01DA063565';
UPDATE public.projects SET grant_number = 'U01DA063565' WHERE grant_number = '1U01DA063565';
UPDATE public.curation_audit_log SET grant_number = 'U01DA063565' WHERE grant_number = '1U01DA063565';
UPDATE public.edit_history SET grant_number = 'U01DA063565' WHERE grant_number = '1U01DA063565';
UPDATE public.project_device_usage SET grant_number = 'U01DA063565' WHERE grant_number = '1U01DA063565';
UPDATE public.grant_methods_evidence SET seed_grant_number = 'U01DA063565' WHERE seed_grant_number = '1U01DA063565';
UPDATE public.grant_methods_evidence SET source_grant_number = 'U01DA063565' WHERE source_grant_number = '1U01DA063565';
UPDATE public.grant_methods_traversal_paths SET seed_grant_number = 'U01DA063565' WHERE seed_grant_number = '1U01DA063565';
UPDATE public.proposed_relations SET seed_grant_number = 'U01DA063565' WHERE seed_grant_number = '1U01DA063565';

--   1U01DA063581 -> U01DA063581
UPDATE public.grants SET grant_number = 'U01DA063581' WHERE grant_number = '1U01DA063581';
UPDATE public.projects SET grant_number = 'U01DA063581' WHERE grant_number = '1U01DA063581';
UPDATE public.curation_audit_log SET grant_number = 'U01DA063581' WHERE grant_number = '1U01DA063581';
UPDATE public.edit_history SET grant_number = 'U01DA063581' WHERE grant_number = '1U01DA063581';
UPDATE public.project_device_usage SET grant_number = 'U01DA063581' WHERE grant_number = '1U01DA063581';
UPDATE public.grant_methods_evidence SET seed_grant_number = 'U01DA063581' WHERE seed_grant_number = '1U01DA063581';
UPDATE public.grant_methods_evidence SET source_grant_number = 'U01DA063581' WHERE source_grant_number = '1U01DA063581';
UPDATE public.grant_methods_traversal_paths SET seed_grant_number = 'U01DA063581' WHERE seed_grant_number = '1U01DA063581';
UPDATE public.proposed_relations SET seed_grant_number = 'U01DA063581' WHERE seed_grant_number = '1U01DA063581';

--   1U01MH144347-01 -> U01MH144347
UPDATE public.grants SET grant_number = 'U01MH144347' WHERE grant_number = '1U01MH144347-01';
UPDATE public.projects SET grant_number = 'U01MH144347' WHERE grant_number = '1U01MH144347-01';
UPDATE public.curation_audit_log SET grant_number = 'U01MH144347' WHERE grant_number = '1U01MH144347-01';
UPDATE public.edit_history SET grant_number = 'U01MH144347' WHERE grant_number = '1U01MH144347-01';
UPDATE public.project_device_usage SET grant_number = 'U01MH144347' WHERE grant_number = '1U01MH144347-01';
UPDATE public.grant_methods_evidence SET seed_grant_number = 'U01MH144347' WHERE seed_grant_number = '1U01MH144347-01';
UPDATE public.grant_methods_evidence SET source_grant_number = 'U01MH144347' WHERE source_grant_number = '1U01MH144347-01';
UPDATE public.grant_methods_traversal_paths SET seed_grant_number = 'U01MH144347' WHERE seed_grant_number = '1U01MH144347-01';
UPDATE public.proposed_relations SET seed_grant_number = 'U01MH144347' WHERE seed_grant_number = '1U01MH144347-01';

COMMIT;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Every grant_number is now the bare core: expect ZERO rows.
SELECT grant_number FROM public.grants
 WHERE grant_number !~ '^[A-Z][0-9]{2}[A-Z]{2}[0-9]{6}$'
 ORDER BY 1;

-- 2) No orphaned reference survived the rewrite: expect ZERO rows from each.
SELECT 'projects' AS src, p.grant_number
  FROM public.projects p LEFT JOIN public.grants g ON g.grant_number = p.grant_number
 WHERE p.grant_number IS NOT NULL AND g.grant_number IS NULL
UNION ALL
SELECT 'project_device_usage', d.grant_number
  FROM public.project_device_usage d LEFT JOIN public.grants g ON g.grant_number = d.grant_number
 WHERE d.grant_number IS NOT NULL AND g.grant_number IS NULL;

-- 3) The full RePORTER string is retained where we had one.
SELECT grant_number, reporter_project_num
  FROM public.grants
 WHERE reporter_project_num IS NOT NULL
 ORDER BY 1;
