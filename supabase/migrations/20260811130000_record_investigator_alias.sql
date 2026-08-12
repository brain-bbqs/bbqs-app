-- record_investigator_alias: learn an email alias from Google instead of waiting for a human.
--
-- THE BUG THIS CLOSES. The group audit compares Google membership to the KG by ADDRESS. Google
-- compares by IDENTITY. When a member's Google account has more than one address, the two disagree
-- permanently:
--
--   niegil.francis@nyu.edu -> member id 114753211097378846591, stored email nm4075@nyu.edu, ACTIVE
--   nm4075@nyu.edu         -> member id 114753211097378846591, stored email nm4075@nyu.edu, ACTIVE
--
-- members.list returns only the STORED address, so the audit sees niegil.francis@ as missing. Repair
-- POSTs it, Google answers 409 duplicate, and the old code treated 409 as success -- so it reported
-- "added 1" while changing nothing, and the same address came back on the next audit. Forever. The
-- user's summary was exact: "the tool lies to you."
--
-- Two fixes. group-audit now distinguishes added from already-a-member (409) and reports them
-- separately, so a no-op can never again be described as progress. And on a 409 it asks Google which
-- address it actually stores and records it here as a secondary_email, which is precisely what the
-- audit's alt-address matching already consumes -- so the entry disappears for good and the system
-- learns the alias from the authority instead of from someone noticing.
--
-- That last part matters beyond this one person: six alias pairs were hand-backfilled on 2026-08-11
-- (firooz@seas/@engineering, ckendell, joostw, meghan.cum/mc3863, ds5577/david.schneider,
-- aw4614/alex.h.williams) after a human spotted them. This makes that automatic.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260811130000');

CREATE OR REPLACE FUNCTION public.record_investigator_alias(
  _primary_email text,
  _alias         text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _p  text := lower(btrim(_primary_email));
  _a  text := lower(btrim(_alias));
  _id uuid;
BEGIN
  -- Service-role callers (the group-audit function) have no auth.uid(); a signed-in caller must be
  -- admin or curator. Recording an alias changes who a mailing-list audit considers already-present,
  -- so it is not a member-editable field.
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can record an email alias';
  END IF;

  IF _p = '' OR _a = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'both addresses are required');
  END IF;
  IF _p = _a THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'alias equals primary');
  END IF;

  SELECT id INTO _id FROM public.investigators WHERE lower(btrim(email)) = _p LIMIT 1;
  IF _id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', format('no investigator with primary email %s', _p));
  END IF;

  -- Refuse if the alias is some OTHER member's primary address. That is not an alias, it is two
  -- people sharing a Google identity or a data error, and quietly merging their mail would be worse
  -- than leaving the audit noisy.
  IF EXISTS (SELECT 1 FROM public.investigators WHERE lower(btrim(email)) = _a AND id <> _id) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format('%s is another investigator''s primary email — merge the duplicate records instead', _a));
  END IF;

  UPDATE public.investigators
     SET secondary_emails = array_append(coalesce(secondary_emails, '{}'::text[]), _a)
   WHERE id = _id
     AND NOT (_a = ANY (coalesce(secondary_emails, '{}'::text[])));

  RETURN jsonb_build_object('ok', true, 'investigator_id', _id, 'primary_email', _p, 'alias', _a,
                            'already_recorded', NOT FOUND);
END;
$fn$;

COMMENT ON FUNCTION public.record_investigator_alias(text, text) IS
  'Records an email alias discovered from Google (a 409 on a group add means the identity is already a member under a different stored address). Idempotent. Refuses when the alias is another investigator''s primary email — that is a duplicate to merge, not an alias.';

GRANT EXECUTE ON FUNCTION public.record_investigator_alias(text, text) TO authenticated, service_role;

-- Verify: idempotent, and refuses the duplicate-person case. Both should report ok:false / skipped
-- rather than writing anything, since nm4075@nyu.edu IS another investigator's primary email today.
SELECT public.record_investigator_alias('niegil.francis@nyu.edu', 'nm4075@nyu.edu') AS expect_refusal_until_merged;
