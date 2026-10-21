-- People page: show every onboarded member (#232).
--
-- fetchPIs() in src/pages/PrincipalInvestigators.tsx lists only people with a grant_investigators row
-- or a working group. The roster is RePORTER-derived, so onboarded trainees and staff with no grant
-- picked were invisible -- Jared Reiling (reported 2026-10-08) among them.
--
-- investigators_public gains one boolean, `onboarded`, appended per the view-columns guard. A record
-- with an email (or a completed onboarding) is an onboarded person: the RePORTER import creates
-- email-less stubs, and the form always carries an email. Offboarded members are excluded. Only the
-- boolean is exposed; the email stays out of this anon-readable view. Until this is applied the page
-- falls back to today's behaviour.
--
-- Not here: Jared's grant link. Linking him to R34DA061924 is an inference (the only BBQS award at
-- MSU; the workshop seating plan), so it goes through onboard_member once Mengsen Zhang confirms.
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

-- ── 2. Audit: every onboarded member with no grant affiliation ─────────────
-- `hidden_before_fix` = was invisible on /investigators (no grant AND no working group). Every row
-- here is now listed on the page but still has no grant: each needs a grant picked (onboard_member,
-- or the admin console) or confirming as grant-free (NIH program staff, consortium admin).
SELECT i.name, i.email, i.institution, i.role AS consortium_role,
       coalesce(array_length(i.working_groups, 1), 0) = 0 AS hidden_before_fix,
       i.working_groups,
       i.onboarding_checklist ->> 'grant_link' AS grant_link_step
  FROM public.investigators i
  JOIN public.investigators_public p ON p.id = i.id
 WHERE p.onboarded
   AND NOT EXISTS (SELECT 1 FROM public.grant_investigators gi WHERE gi.investigator_id = i.id)
 ORDER BY hidden_before_fix DESC, i.role, i.name;
