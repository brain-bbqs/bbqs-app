-- People page: show every onboarded member, and link Jared Reiling to his grant.
--
-- REPORTED 2026-10-08: Jared Reiling (reiling1@msu.edu, Michigan State, Postdoc/Grad Student) is
-- missing from /investigators, and has no grant affiliation.
--
-- CAUSE. fetchPIs() in src/pages/PrincipalInvestigators.tsx skips anyone with no
-- grant_investigators row AND no working group. The roster is RePORTER-derived, so it holds PIs;
-- trainees and staff onboarded through the Google Form get a roster row only if someone picked a
-- grant for them, and onboard_member() allows grant-free members by design (_grant_id NULL ->
-- grant_link 'not_started'). Jared has neither, so he is invisible. The committed KG export
-- (kg/export/quality.json, 2026-09-30) confirms it: his node is flagged "isolated", degree 0.
--
-- He is not alone. Of the 159 people in the onboarding roster (seed-consortium), 34 have no
-- working group; 21 of those are not PIs, so the roster is the only thing that could surface them,
-- and section 4 below lists who is still hidden on the live data.
--
-- THE FIX, in two halves:
--   1. investigators_public gains one boolean, `onboarded` — appended, per the view-columns guard.
--      An email-bearing record is an onboarded person: RePORTER import creates email-less stubs
--      (the rule onboard_member() and 20260831120000 already use to tell them apart), and the form
--      always carries an email. Offboarded members are excluded. The email itself stays out of
--      this anon-safe view; only the boolean is exposed. The page includes `onboarded` rows even
--      with no grant or working group, and degrades to today's behaviour until this is applied.
--   2. Jared's grant link: R34DA061924 (Zhang – Ferret Social, Michigan State University). It is
--      the only BBQS award at MSU (src/data/marr-projects.ts), and the 2026 MIT workshop seating
--      plan puts him in domain B with Mengsen Zhang (MSU PI). Role 'trainee', not postdoc or
--      graduate_student: his form answer is "Postdoc/Grad Student", and normalize_grant_role
--      passes 'trainee' through deliberately rather than guess a career stage nobody stated.
--      CONFIRM WITH MENGSEN ZHANG if in doubt — this is a curator inference, not a registry fact.
--
-- Apply MANUALLY in the KG SQL editor.

SELECT public.set_actor('migration:20261008_people_page_onboarded_members');

-- ── 1. investigators_public: append `onboarded` ────────────────────────────
CREATE OR REPLACE VIEW public.investigators_public
WITH (security_invoker = false) AS
SELECT
  id, name, orcid, profile_url, role, working_groups, research_areas,
  skills, resource_id, scholar_id, user_id, pending_role,
  created_at, updated_at,
  (nullif(btrim(coalesce(email, '')), '') IS NOT NULL OR onboarding_completed_at IS NOT NULL)
    AND coalesce(onboarding_checklist ->> 'status', '') <> 'offboarded' AS onboarded
FROM public.investigators;

-- ── 2. Jared Reiling -> R34DA061924 ────────────────────────────────────────
SELECT public.set_source_class('curator_fill');

DO $do$
DECLARE
  _grant_id uuid;
  _inv_id   uuid;
  _n        int;
BEGIN
  SELECT count(*), min(id::text)::uuid INTO _n, _grant_id
    FROM public.grants WHERE grant_number ILIKE '%R34DA061924%';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one grant matching R34DA061924, found %', _n;
  END IF;

  SELECT count(*), min(id::text)::uuid INTO _n, _inv_id
    FROM public.investigators
   WHERE lower(btrim(email)) = 'reiling1@msu.edu'
      OR 'reiling1@msu.edu' = ANY (SELECT lower(btrim(s)) FROM unnest(coalesce(secondary_emails, '{}')) s);
  IF _n <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one investigator for reiling1@msu.edu, found %', _n;
  END IF;

  INSERT INTO public.grant_investigators (grant_id, investigator_id, role, role_source)
  VALUES (_grant_id, _inv_id, 'trainee', 'curator')
  ON CONFLICT (grant_id, investigator_id) DO NOTHING;

  UPDATE public.investigators
     SET institution = coalesce(nullif(btrim(institution), ''), 'Michigan State University'),
         onboarding_checklist = coalesce(onboarding_checklist, '{}'::jsonb)
                                || jsonb_build_object('grant_link', 'done')
   WHERE id = _inv_id;

  -- The page's Institution column reads investigator_organizations, not the free-text field.
  INSERT INTO public.investigator_organizations (investigator_id, organization_id)
  SELECT _inv_id, o.id
    FROM public.organizations o
   WHERE lower(btrim(o.name)) = 'michigan state university'
   LIMIT 1
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Jared Reiling % linked to R34DA061924 %', _inv_id, _grant_id;
END
$do$;

-- ── 3. Verify Jared ────────────────────────────────────────────────────────
SELECT i.name, i.institution, i.role AS consortium_role, g.grant_number,
       gi.role AS roster_role, gi.role_source, p.onboarded
  FROM public.investigators i
  JOIN public.investigators_public p ON p.id = i.id
  LEFT JOIN public.grant_investigators gi ON gi.investigator_id = i.id
  LEFT JOIN public.grants g ON g.id = gi.grant_id
 WHERE lower(i.email) = 'reiling1@msu.edu';

-- ── 4. Audit: every onboarded member with no grant affiliation ─────────────
-- `hidden_before_fix` = was invisible on /investigators (no grant AND no working group).
-- Every row here is now listed on the page, but still has no grant affiliation — each needs a
-- grant picked (onboard_member / the admin console) or confirmed grant-free (NIH program staff,
-- consortium admin).
SELECT i.name, i.email, i.institution, i.role AS consortium_role,
       coalesce(array_length(i.working_groups, 1), 0) = 0 AS hidden_before_fix,
       i.working_groups,
       i.onboarding_checklist ->> 'grant_link' AS grant_link_step
  FROM public.investigators i
  JOIN public.investigators_public p ON p.id = i.id
 WHERE p.onboarded
   AND NOT EXISTS (SELECT 1 FROM public.grant_investigators gi WHERE gi.investigator_id = i.id)
 ORDER BY hidden_before_fix DESC, i.role, i.name;
