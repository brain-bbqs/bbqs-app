-- Offboarding RPC for the admin console (P3).
--
-- Mirrors the agent's offboarding semantics (src/server/onboarding/offboarding/):
--   OFFBOARD = a member leaves ONE grant. MULTI-GRANT-SAFE: access justified by a REMAINING
--              grant is kept. The investigator record is never deleted.
--   RESET    = test-fixture teardown that DELETES the record. Deliberately NOT exposed here.
--
-- Two-step by design: this RPC does the DATABASE part and RETURNS the Google Groups that are no
-- longer justified; the console then performs the external removal explicitly (group-audit
-- action:'remove_groups'). Mailing-list removal is outward-facing, so it stays a separate,
-- visible action rather than a hidden side effect of a DB call.
--
-- Group policy (same as offboarding/policy.ts):
--   consortium@ / wg-*@    kept while ANY grant remains
--   pi@                    kept only if a REMAINING roster role is an NIH PI role
--                          (contact_pi/co_pi/mpi/PI) — co-investigator does NOT qualify
--   young-investigators@   kept only if a REMAINING role is postdoc/graduate_student
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor.

CREATE OR REPLACE FUNCTION public.offboard_member(
  _investigator_id uuid,
  _grant_id        uuid DEFAULT NULL   -- NULL = leaving the consortium entirely (all grants)
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _email text;
  _name text;
  _wgs text[];
  _removed int := 0;
  _remaining_roles text[];
  _remaining_grants text[];
  _full boolean;
  _groups text[] := '{}';
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can offboard members';
  END IF;

  SELECT email, name, coalesce(working_groups, '{}')
    INTO _email, _name, _wgs
  FROM public.investigators WHERE id = _investigator_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Investigator % not found', _investigator_id;
  END IF;

  -- 1. Remove the roster row(s) for the grant being left (or all rows for a full departure).
  IF _grant_id IS NULL THEN
    DELETE FROM public.grant_investigators WHERE investigator_id = _investigator_id;
  ELSE
    DELETE FROM public.grant_investigators
     WHERE investigator_id = _investigator_id AND grant_id = _grant_id;
  END IF;
  GET DIAGNOSTICS _removed = ROW_COUNT;

  -- 2. What still justifies access?
  SELECT coalesce(array_agg(DISTINCT gi.role), '{}'),
         coalesce(array_agg(DISTINCT g.grant_number), '{}')
    INTO _remaining_roles, _remaining_grants
  FROM public.grant_investigators gi
  JOIN public.grants g ON g.id = gi.grant_id
  WHERE gi.investigator_id = _investigator_id;

  _full := coalesce(array_length(_remaining_grants, 1), 0) = 0;

  -- 3. Which Google Groups are no longer justified.
  IF _full THEN
    _groups := ARRAY['consortium@brain-bbqs.org', 'pi@brain-bbqs.org', 'young-investigators@brain-bbqs.org'];
    _groups := _groups || coalesce((
      SELECT array_agg('wg-' || lower(replace(wg, 'WG-', '')) || '@brain-bbqs.org')
      FROM unnest(_wgs) wg
    ), '{}');
  ELSE
    -- Partial departure: consortium@ and the wg-*@ lists stay (a grant remains). Only the
    -- ROLE-derived lists can lapse.
    IF NOT EXISTS (SELECT 1 FROM unnest(_remaining_roles) r
                    WHERE lower(r) IN ('pi', 'contact_pi', 'co_pi', 'mpi')) THEN
      _groups := _groups || ARRAY['pi@brain-bbqs.org'];
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(_remaining_roles) r
                    WHERE lower(r) IN ('postdoc', 'graduate_student')) THEN
      _groups := _groups || ARRAY['young-investigators@brain-bbqs.org'];
    END IF;
  END IF;

  -- 4. On a FULL departure only, mark the record offboarded (mirrors the agent's
  --    offboardedInvestigatorPatch). A partial departure leaves onboarding state intact.
  IF _full THEN
    UPDATE public.investigators
       SET onboarding_completed_at = NULL,
           onboarding_checklist = jsonb_build_object(
             'status', 'offboarded',
             'offboarded_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
     WHERE id = _investigator_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'investigator_id', _investigator_id,
    'name', _name,
    'email', _email,
    'roster_rows_removed', _removed,
    'full_departure', _full,
    'remaining_grants', _remaining_grants,
    'remaining_roles', _remaining_roles,
    'groups_to_remove', _groups,
    'slack_removal_recommended', _full
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.offboard_member(uuid, uuid) TO authenticated;
