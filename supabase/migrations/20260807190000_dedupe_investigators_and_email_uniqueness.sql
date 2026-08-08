-- Merge duplicate investigators and stop new ones being created.
--
-- Found via a member showing up with the name "7/24/2026 16 07 06" — a Google-Form TIMESTAMP
-- parsed as a person's name. Provenance (data_audit_log) shows that row was INSERTed
-- 2026-08-06 21:49 under an admin JWT, i.e. a raw form row was fed to an onboard flow and the
-- leading timestamp became the name.
--
-- ROOT CAUSE, though, is structural: investigators has UNIQUE(name) but NOT unique(email).
-- That is backwards — EMAIL is the identity key (Globus sign-in matches on it, mailing lists
-- key on it), while names legitimately collide. The missing constraint let two rows share an
-- email, which also means auto_link_investigator can bind an auth account to the wrong row and
-- an email-keyed backfill silently updates BOTH.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor.

-- ── 1. Sankar Alagapan — delete the timestamp-named duplicate ─────────────────
-- Keeper 1ef1d572 is the real record: linked to an auth account, role Co-Investigator, on the
-- grant roster. The duplicate 4477d117 has no account, no role and no roster rows; its only
-- content (institution 'Gatech', and the orcid/working_groups my own backfill wrote to it
-- because it matched on email) is already correct on the keeper.
DELETE FROM public.grant_investigators WHERE investigator_id = '4477d117-35dd-430c-85a9-e4aca7e2412d';
DELETE FROM public.investigators       WHERE id              = '4477d117-35dd-430c-85a9-e4aca7e2412d';

-- ── 2. Joseph Neimat — merge the two rows ─────────────────────────────────────
-- 3bce9664 "Joseph S Neimat" is LINKED to his auth account (user_id), so it must be the keeper
-- — deleting it would break his sign-in. 2351859a "Joseph Neimat" holds the better data:
-- role contact_pi, working groups, and the correct current institution (the keeper still shows
-- a stale NIH-derived 'UNIVERSITY OF PITTSBURGH AT PITTSBURGH'). Both are on the SAME grant
-- (7e061a35) with different roles, so he currently appears twice on that roster.
UPDATE public.investigators k SET
  name           = 'Joseph Neimat',
  role           = coalesce(nullif(btrim(k.role), ''), d.role),
  institution    = d.institution,
  working_groups = (SELECT array_agg(DISTINCT x)
                    FROM unnest(coalesce(k.working_groups,'{}') || coalesce(d.working_groups,'{}')) x),
  orcid          = coalesce(nullif(btrim(k.orcid), ''), d.orcid),
  secondary_emails = (SELECT array_agg(DISTINCT x)
                      FROM unnest(coalesce(k.secondary_emails,'{}') || coalesce(d.secondary_emails,'{}')) x)
FROM public.investigators d
WHERE k.id = '3bce9664-be62-45ef-93e6-7f6c0af639b3'
  AND d.id = '2351859a-8fd0-4933-9223-58ed9f1dedb3';

-- Keep the more accurate roster role (contact_pi) on the keeper, then drop the duplicate's row.
UPDATE public.grant_investigators SET role = 'contact_pi'
 WHERE investigator_id = '3bce9664-be62-45ef-93e6-7f6c0af639b3'
   AND grant_id = '7e061a35-8f96-4aa2-91a0-2e9da72bdd69';
DELETE FROM public.grant_investigators WHERE investigator_id = '2351859a-8fd0-4933-9223-58ed9f1dedb3';
DELETE FROM public.investigators       WHERE id              = '2351859a-8fd0-4933-9223-58ed9f1dedb3';

-- ── 3. Prevent recurrence: one investigator per email ─────────────────────────
-- Partial index: 25 legacy rows have NULL/empty email and must stay allowed (NULLs never
-- collide in Postgres, but '' would). Case-insensitive because Globus and mailing lists are.
CREATE UNIQUE INDEX IF NOT EXISTS investigators_email_unique_ci
  ON public.investigators (lower(btrim(email)))
  WHERE email IS NOT NULL AND btrim(email) <> '';

-- ── 4. Verify (should return zero rows) ───────────────────────────────────────
-- SELECT lower(btrim(email)) e, count(*) FROM public.investigators
--  WHERE email IS NOT NULL AND btrim(email) <> '' GROUP BY 1 HAVING count(*) > 1;
