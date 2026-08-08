-- Merge the Alex Williams duplicate (found while verifying working groups).
--
-- The email-uniqueness index from 20260807190000 could NOT catch this one: the duplicate has a
-- NULL email, and NULLs never collide. It was found instead by matching ORCID + secondary
-- email — both records carry ORCID 0000-0001-5853-103X and awilliams@flatironinstitute.org,
-- and both are NYU, so they are one person split in two:
--   9ff326e3  "Alex Williams"            email aw4614@nyu.edu, role PI, WG-Analytics, NO grants
--   bfe33143  "Alexander Henry Williams" email NULL, no role, no WGs, but holds BOTH grant
--                                        roster rows (co_pi on 2 grants)
-- i.e. his EMAIL and his GRANTS live on different rows, so neither view of him is complete.
--
-- Keeper is 9ff326e3 because it has the email — the identity key for Globus sign-in and
-- mailing lists. The grant roster rows are repointed to it (no conflict: it has none), then
-- the duplicate is deleted. Idempotent.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor.

-- 1. Move the grant-roster rows to the keeper.
UPDATE public.grant_investigators
   SET investigator_id = '9ff326e3-f123-4d27-9f6e-2063b2da23fe'
 WHERE investigator_id = 'bfe33143-ea7a-4794-af25-582cb656bc14'
   AND NOT EXISTS (
     SELECT 1 FROM public.grant_investigators x
      WHERE x.investigator_id = '9ff326e3-f123-4d27-9f6e-2063b2da23fe'
        AND x.grant_id = public.grant_investigators.grant_id
   );

-- 2. Fill any gap on the keeper from the duplicate (fill-only-empty).
UPDATE public.investigators k SET
  orcid       = coalesce(nullif(btrim(k.orcid), ''), d.orcid),
  institution = coalesce(nullif(btrim(k.institution), ''), d.institution)
FROM public.investigators d
WHERE k.id = '9ff326e3-f123-4d27-9f6e-2063b2da23fe'
  AND d.id = 'bfe33143-ea7a-4794-af25-582cb656bc14';

-- 3. Remove the duplicate (any roster rows left are exact dupes of the keeper's).
DELETE FROM public.grant_investigators WHERE investigator_id = 'bfe33143-ea7a-4794-af25-582cb656bc14';
DELETE FROM public.investigators       WHERE id              = 'bfe33143-ea7a-4794-af25-582cb656bc14';

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT name, email, working_groups,
--        (SELECT count(*) FROM grant_investigators gi WHERE gi.investigator_id = i.id) AS grants
--   FROM investigators i WHERE orcid = '0000-0001-5853-103X';
-- Expect ONE row: Alex Williams / aw4614@nyu.edu / {WG-Analytics} / 2 grants.
