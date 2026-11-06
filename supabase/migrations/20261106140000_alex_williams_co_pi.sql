-- Alex Williams is co-PI on both Sanes awards (R34DA059513, U01DA063581): confirmed by Sulstice on 2026-11-06,
-- from the curated people list. He has no roster row on either, so the graph and the pi@ entitlement (which
-- derives from grant_investigators, Principle III) don't know him as a PI. co_pi is a canonical PI token
-- (normalize_grant_role; tests/guards/role-vocabulary-parity), so this does add him to pi@ at the next group sync.
-- grant_investigators has no group-sync trigger: pi@ follows on the next sync-member-groups / group-audit run.
-- Idempotent: an existing row for the same grant and person is left as it is.
SELECT public.set_actor('migration:alex_williams_co_pi');
SELECT public.set_source_class('curator_fill');

INSERT INTO public.grant_investigators (grant_id, investigator_id, role, role_source)
SELECT g.id, i.id, 'co_pi', 'curator'
  FROM public.grants g
  JOIN public.investigators i ON i.id = '9ff326e3-f123-4d27-9f6e-2063b2da23fe'
 WHERE g.grant_number IN ('R34DA059513', 'U01DA063581')
ON CONFLICT (grant_id, investigator_id) DO NOTHING;

-- Verify: expect 2 rows, role co_pi.
SELECT g.grant_number, gi.role, gi.role_source
  FROM public.grant_investigators gi JOIN public.grants g ON g.id = gi.grant_id
 WHERE gi.investigator_id = '9ff326e3-f123-4d27-9f6e-2063b2da23fe' AND g.grant_number IN ('R34DA059513', 'U01DA063581');
