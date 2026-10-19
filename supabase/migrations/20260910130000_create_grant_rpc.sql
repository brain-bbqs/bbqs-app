-- create_grant(): onboard an award that is NOT YET on NIH RePORTER (a funder notice), from MCP.
--
-- WHY THIS EXISTS. The MCP curator surface could link a person to a grant (onboard_member, which
-- takes a grant_id and RAISES if the grant is unknown) and enrich a grant from the registry
-- (refresh_grant_from_reporter, a no-op until RePORTER has it) — but it had no way to CREATE the
-- grant record itself. So a team introduced by a program officer weeks ahead of the registry (the
-- R61MH142354 case on 2026-08-31, the U01MH143789 case on 2026-09-10) could only be onboarded by a
-- hand-written migration. This closes that gap: an admin/curator can seed the pre-registry award
-- over MCP, and the normal flow (onboard_member -> sync_member_groups -> refresh_grant_from_reporter)
-- takes over from there.
--
-- PROVENANCE IS AUTOMATIC. This declares set_source_class('funder_notice') once, so the AFTER INSERT
-- recorder (20260831160000) self-documents every cell of the new grant / project / roster row as a
-- funder_notice (G1) claim. No hand-written field_provenance, unlike 20260831150000 which predated
-- the recorder. The audit actor is bbqs-mcp:<email> via the x-bbqs-client header the MCP server sets.
--
-- Does NOT create people: an unknown contact PI is reported back, not invented — person creation
-- stays onboard_member's job (twin-detection, checklist, group sync). Does NOT provision Google
-- Groups: a roster INSERT does not fire trg_sync_member_groups (AFTER UPDATE on investigators), and
-- group provisioning is a separate, additive, outward-facing step (sync_member_groups).
--
-- Apply MANUALLY in the KG SQL editor (project vpexxhfpvghlejljwpvt), THEN deploy the function:
--   supabase functions deploy bbqs-mcp --project-ref vpexxhfpvghlejljwpvt

SELECT public.set_actor('migration:20260910_create_grant_rpc');

-- ── Preconditions (idempotent; first added for R61MH142354 on 2026-08-31, repeated so this
--    migration is self-contained even if that one was never applied here) ──────────────────────────
INSERT INTO public.source_classes (code, grade, label, agent_kind, is_verified, description)
VALUES ('funder_notice', 1, 'Funder award notice', 'human', true,
        'A named program officer at the funding institute stating an award, its title, or its investigators directly — by email or letter — ahead of the public registry. Same authority as authoritative_registry and often months earlier; a distinct code so claims awaiting RePORTER confirmation stay queryable.')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.grant_investigators DROP CONSTRAINT IF EXISTS grant_investigators_role_source_check;
ALTER TABLE public.grant_investigators ADD CONSTRAINT grant_investigators_role_source_check
  CHECK (role_source IN ('reporter', 'curator', 'funder_notice'));

-- ── The RPC ─────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_grant(
  _grant_number     text,
  _title            text,
  _fiscal_year      int     DEFAULT NULL,
  _institution      text    DEFAULT NULL,   -- awardee org; when given, creates the project row
  _study_human      boolean DEFAULT NULL,
  _contact_pi_email text    DEFAULT NULL    -- linked as contact_pi ONLY if already in the KG
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid              uuid    := auth.uid();
  -- grants.grant_number is the CORE project number, no year suffix: 'U01MH143789-01' -> 'U01MH143789'
  -- (reporter_project_num carries the full per-year number). Upper-cased to match the registry.
  _gn               text    := upper(regexp_replace(btrim(coalesce(_grant_number, '')), '-\d+$', ''));
  _title_n          text    := btrim(coalesce(_title, ''));
  _grant_id         uuid;
  _created          boolean := false;
  _org_id           uuid;
  _project_id       uuid;
  _project_created  boolean := false;
  _pi_id            uuid;
  _pi_result        text    := NULL;
BEGIN
  -- Same authority as onboard_member. The MCP step-up gate already blocks non-curators, but a
  -- SECURITY DEFINER function must not trust its caller to have been gated elsewhere.
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can create a grant';
  END IF;
  IF _gn = '' THEN
    RAISE EXCEPTION 'grant_number is required';
  END IF;
  IF _title_n = '' THEN
    RAISE EXCEPTION 'title is required — the award is not on RePORTER, so nothing else can supply it';
  END IF;

  -- Declare the class ONCE for the whole transaction, so the AFTER INSERT recorder documents every
  -- new row below as a funder_notice claim.
  PERFORM public.set_source_class('funder_notice');

  -- ── The award (idempotent on grant_number) ─────────────────────────────────────────────────────
  SELECT id INTO _grant_id FROM public.grants WHERE grant_number = _gn;
  IF _grant_id IS NULL THEN
    INSERT INTO public.grants (grant_number, title, fiscal_year)
    VALUES (_gn, _title_n, _fiscal_year)
    RETURNING id INTO _grant_id;
    _created := true;
  ELSE
    -- Fill only what is empty; never clobber a title/year a RePORTER refresh may already have set.
    UPDATE public.grants
       SET title       = coalesce(nullif(btrim(title), ''), _title_n),
           fiscal_year = coalesce(fiscal_year, _fiscal_year)
     WHERE id = _grant_id;
  END IF;

  -- ── The awardee project row (only when an institution is given) ─────────────────────────────────
  IF nullif(btrim(_institution), '') IS NOT NULL THEN
    SELECT id INTO _org_id FROM public.organizations
     WHERE lower(btrim(name)) = lower(btrim(_institution)) LIMIT 1;
    IF _org_id IS NULL THEN
      INSERT INTO public.organizations (name) VALUES (btrim(_institution)) RETURNING id INTO _org_id;
    END IF;

    SELECT id INTO _project_id FROM public.projects WHERE grant_id = _grant_id LIMIT 1;
    IF _project_id IS NULL THEN
      INSERT INTO public.projects (grant_id, grant_number, organization_id, study_human)
      VALUES (_grant_id, _gn, _org_id, _study_human)
      RETURNING id INTO _project_id;
      _project_created := true;
    END IF;
  END IF;

  -- ── Link an EXISTING contact PI (person creation stays onboard_member's job) ────────────────────
  IF nullif(btrim(_contact_pi_email), '') IS NOT NULL THEN
    SELECT id INTO _pi_id FROM public.investigators
     WHERE lower(btrim(email)) = lower(btrim(_contact_pi_email))
        OR EXISTS (SELECT 1 FROM unnest(coalesce(secondary_emails, '{}')) s
                    WHERE lower(btrim(s)) = lower(btrim(_contact_pi_email)))
     LIMIT 1;
    IF _pi_id IS NULL THEN
      _pi_result := 'not_found — create the person with onboard_member(grant_id, …)';
    ELSE
      -- role_source funder_notice: this seat came from the notice, not the registry or a bare curator
      -- entry. pi@ derives from this row (#283). No id column conflict target here → DO NOTHING.
      INSERT INTO public.grant_investigators (grant_id, investigator_id, role, role_source)
      VALUES (_grant_id, _pi_id, 'contact_pi', 'funder_notice')
      ON CONFLICT DO NOTHING;
      IF _org_id IS NOT NULL THEN
        INSERT INTO public.investigator_organizations (investigator_id, organization_id)
        VALUES (_pi_id, _org_id) ON CONFLICT DO NOTHING;
      END IF;
      _pi_result := 'linked:' || _pi_id::text;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'grant_id', _grant_id,
    'grant_number', _gn,
    'created', _created,
    'title', (SELECT title FROM public.grants WHERE id = _grant_id),
    'fiscal_year', (SELECT fiscal_year FROM public.grants WHERE id = _grant_id),
    'project_created', _project_created,
    'contact_pi', _pi_result,
    'next', 'onboard_member(grant_id) for any PI/member not yet in the KG; sync_member_groups for group access; refresh_grant_from_reporter once the award is on RePORTER (fills abstract/amount/publications, adds MPIs, never demotes a role)'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_grant(text, text, int, text, boolean, text) TO authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────────────────────────
-- Signature and grant present.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'create_grant';
