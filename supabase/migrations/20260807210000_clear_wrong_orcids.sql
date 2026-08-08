-- Clear ORCIDs that belong to someone else.
--
-- Found by scanning for duplicate ORCIDs: two pairs shared an identifier but are clearly
-- DIFFERENT people (unlike the Alex Williams case, which was one person split across two rows).
-- These are contaminated records, so the wrong value is removed rather than merged:
--   Yuyi Chang      (chang.1560@osu.edu) carried Han Yi's ORCID 0000-0001-7152-3712
--   Tekraj Chhetri  (tekraj@mit.edu)     carried Satrajit Ghosh's ORCID 0000-0002-6911-4929
-- The rightful owners (Han Yi, Satrajit Ghosh) keep theirs untouched.
--
-- Guarded by BOTH email and the specific wrong ORCID, so this can never clear a correct value
-- and is safe to re-run.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor.

UPDATE public.investigators SET orcid = NULL
 WHERE lower(email) = 'chang.1560@osu.edu' AND orcid = '0000-0001-7152-3712';

UPDATE public.investigators SET orcid = NULL
 WHERE lower(email) = 'tekraj@mit.edu'     AND orcid = '0000-0002-6911-4929';

-- ── OPTIONAL but recommended: the same contamination in secondary_emails ──────
-- Yuyi Chang's record also carries HAN YI's personal address (hanyijhuapl@gmail.com). That is
-- an identity hazard, not just untidy: secondary_emails is used to match people at Globus
-- sign-in and for mailing lists, so if Han Yi ever signs in with that gmail he could be linked
-- to YUYI CHANG's record. Uncomment to remove it (Han Yi's own record is unaffected).
--
-- UPDATE public.investigators
--    SET secondary_emails = array_remove(secondary_emails, 'hanyijhuapl@gmail.com')
--  WHERE lower(email) = 'chang.1560@osu.edu';

-- ── Verify (should return no rows) ────────────────────────────────────────────
-- SELECT name, email, orcid FROM public.investigators
--  WHERE orcid IN ('0000-0001-7152-3712','0000-0002-6911-4929')
--    AND lower(email) IN ('chang.1560@osu.edu','tekraj@mit.edu');
