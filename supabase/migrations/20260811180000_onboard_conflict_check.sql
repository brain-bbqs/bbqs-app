-- check_onboard_conflicts: say what is wrong BEFORE the insert, not as a Postgres error code.
--
-- THE CASE (2026-08-17). An access request arrived for "Flavia Vitale,
-- vitalef@pennmedicine.upenn.esu" -- .esu, a typo for .edu. Approve-and-onboard then failed with
--   duplicate key value violates unique constraint "investigators_name_key"
-- which is true, safe, and tells an admin nothing about what to do.
--
-- WHY IT REACHED THE INSERT. onboard_member looks up by EMAIL; the typo'd address matches nothing. The
-- stub reconciliation added in 20260810130000 then looks for an EMAIL-LESS record with the same
-- normalized name -- but Flavia's record already has an email, so it is not a stub and does not match.
-- With no email match and no stub, the RPC inserts, and the name unique index stops it. The index did
-- its job: without it there would now be a second Flavia Vitale with an address that does not exist.
--
-- WHAT THIS ADDS. A read-only pre-check the console runs before submitting, so the admin sees the
-- actual situation and the existing address:
--   name_conflict      a record with this name exists under a DIFFERENT email -- almost always a typo
--                      in the new address, occasionally two people who share a name
--   email_is_member    this address is already a member (the request was unnecessary)
--   stub_will_adopt    an email-less record with this name will be claimed rather than duplicated
--   near_miss_email    an existing address differs from the typed one only slightly, which is what a
--                      mistyped domain looks like
--
-- The near-miss test is deliberately conservative: same local part, different domain, or a domain one
-- character off. Fuzzy matching has already gone wrong in this project once, mapping "University of
-- Pennsylvania" to "PENNSYLVANIA STATE UNIVERSITY", so this only REPORTS a suspicion for a human to
-- judge and never acts on it.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260811180000');

CREATE OR REPLACE FUNCTION public.check_onboard_conflicts(_email text, _name text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _e        text := lower(btrim(coalesce(_email, '')));
  _n        text := lower(regexp_replace(btrim(coalesce(_name, '')), '[[:space:]]+', ' ', 'g'));
  _local    text := split_part(_e, '@', 1);
  _domain   text := split_part(_e, '@', 2);
  _conflict jsonb := '[]'::jsonb;
  r         record;
BEGIN
  -- Gate SIGNED-IN callers only. A NULL auth.uid() means service role, a migration, or the SQL editor,
  -- none of which a role check can meaningfully constrain -- and enforcing it unconditionally made the
  -- verify queries at the bottom of this file fail with P0001 in the very editor used to apply it.
  -- Same shape as record_investigator_alias (20260811130000). This function only READS and reports.
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can check onboarding conflicts';
  END IF;

  -- 1. This exact address is already a member: nothing to onboard.
  IF _e <> '' AND public.email_is_consortium_member(_e) THEN
    SELECT i.name, i.email INTO r
      FROM public.investigators i
     WHERE lower(btrim(i.email)) = _e
        OR EXISTS (SELECT 1 FROM unnest(coalesce(i.secondary_emails, '{}')) s WHERE lower(btrim(s)) = _e)
     LIMIT 1;
    _conflict := _conflict || jsonb_build_object(
      'kind', 'email_is_member',
      'existing_name', r.name,
      'existing_email', r.email,
      'message', format('%s is already a consortium member as %s — onboarding will update that record, not create one.', _e, r.name));
  END IF;

  -- 2. Same name, different email. The blocking case: the insert would hit investigators_name_key.
  FOR r IN
    SELECT i.name, i.email, i.secondary_emails
      FROM public.investigators i
     WHERE lower(regexp_replace(btrim(i.name), '[[:space:]]+', ' ', 'g')) = _n
       AND i.email IS NOT NULL AND btrim(i.email) <> ''
       AND lower(btrim(i.email)) <> _e
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(i.secondary_emails, '{}')) s WHERE lower(btrim(s)) = _e)
  LOOP
    _conflict := _conflict || jsonb_build_object(
      'kind', 'name_conflict',
      'existing_name', r.name,
      'existing_email', r.email,
      'message', format(
        '"%s" already exists with the address %s. If that is the same person, use that address (or add %s as a secondary email); if it is a different person, give a distinguishing name. Submitting as-is will fail on the name uniqueness index.',
        r.name, r.email, _e));
  END LOOP;

  -- 3. An email-less record with this name will be ADOPTED, not duplicated. Reassurance, not a problem.
  FOR r IN
    SELECT i.name
      FROM public.investigators i
     WHERE lower(regexp_replace(btrim(i.name), '[[:space:]]+', ' ', 'g')) = _n
       AND (i.email IS NULL OR btrim(i.email) = '')
  LOOP
    _conflict := _conflict || jsonb_build_object(
      'kind', 'stub_will_adopt',
      'existing_name', r.name,
      'message', format('An existing record "%s" has no email (a RePORTER import stub) — onboarding will claim it rather than create a duplicate.', r.name));
  END LOOP;

  -- 4. Near-miss address. Same local part with a different domain, or a domain within one edit.
  --    Reports only; a human decides. Requires pg_trgm-free logic, so the comparison is explicit.
  IF _local <> '' AND _domain <> '' THEN
    FOR r IN
      SELECT i.name, i.email
        FROM public.investigators i
       WHERE i.email IS NOT NULL
         AND lower(split_part(btrim(i.email), '@', 1)) = _local
         AND lower(split_part(btrim(i.email), '@', 2)) <> _domain
    LOOP
      _conflict := _conflict || jsonb_build_object(
        'kind', 'near_miss_email',
        'existing_name', r.name,
        'existing_email', r.email,
        'message', format('%s has the address %s — same mailbox name, different domain. Check the domain you typed (.esu for .edu is the case that prompted this check).', r.name, r.email));
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    -- Blocking = the insert genuinely cannot succeed. The others are advisory.
    'blocking', EXISTS (SELECT 1 FROM jsonb_array_elements(_conflict) c WHERE c ->> 'kind' = 'name_conflict'),
    'conflicts', _conflict);
END;
$fn$;

COMMENT ON FUNCTION public.check_onboard_conflicts(text, text) IS
  'Read-only pre-flight for the onboard wizard: reports name collisions (which would fail on investigators_name_key), addresses that are already members, email-less stubs that will be adopted, and near-miss addresses that look like a typo. Reports only — never acts.';

GRANT EXECUTE ON FUNCTION public.check_onboard_conflicts(text, text) TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- The live case: expect blocking=true with a name_conflict naming vitalef@pennmedicine.upenn.edu,
-- plus a near_miss_email for the same address.
SELECT jsonb_pretty(public.check_onboard_conflicts('vitalef@pennmedicine.upenn.esu', 'Flavia Vitale'));

-- A clean new person: expect blocking=false and an empty conflicts array.
SELECT jsonb_pretty(public.check_onboard_conflicts('nobody.new@example.org', 'Nobody New'));
