-- Onboard U01MH143789 (Nanthia Suthana, sole named PI) ahead of NIH RePORTER, on the funder notice.
--
-- Source: Elizabeth (Lizzy) Ankudowich (lizzy.ankudowich@nih.gov, NIMH, BBQS Co-Lead), email
-- introducing the team to Satra Ghosh and Brock Wester, 2026-09-10. No Message-ID was captured.
-- Title per that notice: "A smart lens platform for real-world event capture and synchronized deep
-- brain dynamics".
--
-- RePORTER returns nothing for U01MH143789 as of 2026-09-10 (refresh_grant_from_reporter was a
-- no-op), so reporter_project_num stays NULL and fiscal_year 2026 is inferred from the "-01" year.
--
-- Suthana already exists (contact_pi on R61MH135106) and is therefore already in consortium@ and
-- pi@, so NO Google Group change is needed for her. This migration records only the new award, her
-- roster seat on it, the Duke project row, and the funder_notice provenance -- and it RESTORES her
-- onboarding_completed_at, which an onboard_member() call on 2026-09-10 cleared while the grant did
-- not yet exist (so the roster link could not take).
--
-- Awardee institution: Duke University (per curator, 2026-09-10). She is recorded under both Duke
-- and UCLA; RePORTER will reconcile once the award is public. The Projects page reads institution
-- from the nih-grants (RePORTER) response, not this row (see useMarrProjects.ts), so it will show
-- "Unknown" until the award lands on RePORTER.
--
-- Does not call onboard_member(): auth.uid() is NULL in the SQL editor, so a roster row written here
-- carries the funder_notice provenance below rather than an app actor.
--
-- Idempotent: safe to re-run. Apply MANUALLY in the KG SQL editor.

SELECT public.set_actor('migration:20260910_onboard_u01mh143789');

-- ── 1. Source class (idempotent; first created for R61MH142354 on 2026-08-31) ──────────
INSERT INTO public.source_classes (code, grade, label, agent_kind, is_verified, description)
VALUES ('funder_notice', 1, 'Funder award notice', 'human', true,
        'A named program officer at the funding institute stating an award, its title, or its investigators directly — by email or letter — ahead of the public registry. Same authority as authoritative_registry and often months earlier; a distinct code so claims awaiting RePORTER confirmation stay queryable.')
ON CONFLICT (code) DO NOTHING;

-- ── 2. Let the roster record a funder_notice source (idempotent) ───────────────────────
ALTER TABLE public.grant_investigators
  DROP CONSTRAINT IF EXISTS grant_investigators_role_source_check;
ALTER TABLE public.grant_investigators
  ADD CONSTRAINT grant_investigators_role_source_check
  CHECK (role_source IN ('reporter', 'curator', 'funder_notice'));

-- NB: we deliberately do NOT set_source_class('funder_notice') here. That would fire the AFTER
-- INSERT recorder (20260831160000), which records a baseline claim per cell but cannot carry the
-- officer's name, her email as source_ref, or the evidence line — and its bare claim would then make
-- section 7's guarded, richer INSERT a no-op. Leaving the class undeclared keeps the recorder quiet
-- so section 7's attributed claims are the ones that land.

-- ── 3. The award ───────────────────────────────────────────────────────────────────────
INSERT INTO public.grants (grant_number, title, fiscal_year)
SELECT 'U01MH143789',
       'A smart lens platform for real-world event capture and synchronized deep brain dynamics',
       2026
WHERE NOT EXISTS (SELECT 1 FROM public.grants WHERE grant_number = 'U01MH143789');

-- Fill title/fiscal_year if a bare grants row already exists (e.g. from the 2026-09-10
-- onboard_member() attempt); never overwrite a non-empty value.
UPDATE public.grants
   SET title       = coalesce(nullif(btrim(title), ''),
                              'A smart lens platform for real-world event capture and synchronized deep brain dynamics'),
       fiscal_year = coalesce(fiscal_year, 2026)
 WHERE grant_number = 'U01MH143789';

-- ── 4. Suthana's roster seat (she already exists; do NOT touch her profile) ─────────────
INSERT INTO public.grant_investigators (grant_id, investigator_id, role, role_source)
SELECT g.id, i.id, 'contact_pi', 'funder_notice'
  FROM public.grants g
  JOIN public.investigators i ON lower(btrim(i.email)) = 'nanthia@ucla.edu'
 WHERE g.grant_number = 'U01MH143789'
ON CONFLICT (grant_id, investigator_id) DO UPDATE
  SET role = EXCLUDED.role, role_source = EXCLUDED.role_source;

-- ── 5. Restore the onboarding_completed_at a 2026-09-10 onboard_member() call cleared ───
--     (only if still NULL — never clobber a value re-set since).
UPDATE public.investigators
   SET onboarding_completed_at = timestamptz '2026-06-17 21:07:50.44+00'
 WHERE lower(btrim(email)) = 'nanthia@ucla.edu'
   AND onboarding_completed_at IS NULL;

-- ── 6. The Duke project row ─────────────────────────────────────────────────────────────
--     Upper-case name to match how nih-grants writes RePORTER's org_name, so this row and a later
--     RePORTER sync collapse to one organization rather than two.
INSERT INTO public.organizations (name)
SELECT 'DUKE UNIVERSITY'
WHERE NOT EXISTS (
  SELECT 1 FROM public.organizations o WHERE lower(btrim(o.name)) = 'duke university'
);

-- study_human: inferred from the PI's human deep-brain recording program and the award title
-- ("real-world event capture and synchronized deep brain dynamics"); to be confirmed by RePORTER.
INSERT INTO public.projects (grant_id, grant_number, organization_id, study_human)
SELECT g.id, g.grant_number, o.id, true
  FROM public.grants g
  CROSS JOIN LATERAL (
    SELECT id FROM public.organizations WHERE lower(btrim(name)) = 'duke university' LIMIT 1
  ) o
 WHERE g.grant_number = 'U01MH143789'
   AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.grant_id = g.id);

-- Link Suthana to Duke (her awardee institution for this award).
INSERT INTO public.investigator_organizations (investigator_id, organization_id)
SELECT i.id, o.id
  FROM public.investigators i
  JOIN public.organizations o ON lower(btrim(o.name)) = 'duke university'
 WHERE lower(btrim(i.email)) = 'nanthia@ucla.edu'
ON CONFLICT DO NOTHING;

-- ── 7. Provenance for the funder_notice claims ──────────────────────────────────────────
--     A brand-new grant/project/roster row is written entirely by INSERT, and
--     trg_enforce_field_provenance is BEFORE UPDATE, so it starts with zero claims. Record them.
--     Guarded so a re-run does not duplicate. Suthana's investigator fields are NOT re-asserted:
--     they pre-date this notice.
INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, evidence, authored_at, authored_at_precision)
-- The award itself
SELECT 'grants', g.id, c.col, 'funder_notice', 'funder_award_notice',
       'Elizabeth Ankudowich, NIMH (BBQS Co-Lead)',
       'email:lizzy.ankudowich@nih.gov 2026-09-10 (team intro to Satra Ghosh & Brock Wester)',
       CASE c.col WHEN 'title' THEN g.title ELSE g.fiscal_year::text END,
       'Introduction of the U01MH143789 team to the BBQS consortium by the NIMH program officer. fiscal_year 2026 inferred from the "-01" award year; awaiting RePORTER.',
       timestamptz '2026-09-10 00:00:00+00', 'day'
  FROM public.grants g
  CROSS JOIN (VALUES ('title'), ('fiscal_year')) AS c(col)
 WHERE g.grant_number = 'U01MH143789'
   AND NOT EXISTS (SELECT 1 FROM public.field_provenance fp
                    WHERE fp.entity_table = 'grants' AND fp.entity_id = g.id
                      AND fp.entity_column = c.col AND fp.source_class = 'funder_notice')

UNION ALL
-- Suthana's seat, and the role pi@ derives from (#283)
SELECT 'grant_investigators', gi.id, c.col, 'funder_notice', 'funder_award_notice',
       'Elizabeth Ankudowich, NIMH (BBQS Co-Lead)',
       'email:lizzy.ankudowich@nih.gov 2026-09-10 (team intro to Satra Ghosh & Brock Wester)',
       CASE c.col WHEN 'role' THEN gi.role ELSE gi.role_source END,
       'Named as the PI on U01MH143789 in the officer''s introduction; recorded as contact_pi (sole named PI). RePORTER may add MPIs later — refresh_grant_from_reporter does not demote roles.',
       timestamptz '2026-09-10 00:00:00+00', 'day'
  FROM public.grant_investigators gi
  JOIN public.grants g        ON g.id = gi.grant_id
  JOIN public.investigators i ON i.id = gi.investigator_id
  CROSS JOIN (VALUES ('role'), ('role_source')) AS c(col)
 WHERE g.grant_number = 'U01MH143789'
   AND lower(btrim(i.email)) = 'nanthia@ucla.edu'
   AND NOT EXISTS (SELECT 1 FROM public.field_provenance fp
                    WHERE fp.entity_table = 'grant_investigators' AND fp.entity_id = gi.id
                      AND fp.entity_column = c.col AND fp.source_class = 'funder_notice')

UNION ALL
-- The project row
SELECT 'projects', p.id, c.col, 'funder_notice', 'funder_award_notice',
       'Elizabeth Ankudowich, NIMH (BBQS Co-Lead)',
       'email:lizzy.ankudowich@nih.gov 2026-09-10 (team intro to Satra Ghosh & Brock Wester)',
       CASE c.col WHEN 'study_human' THEN p.study_human::text ELSE p.organization_id::text END,
       'Awardee institution Duke University per curator (2026-09-10); study_human inferred from the PI''s human deep-brain recording program and the award title. Both to be confirmed by RePORTER.',
       timestamptz '2026-09-10 00:00:00+00', 'day'
  FROM public.projects p
  JOIN public.grants g ON g.id = p.grant_id
  CROSS JOIN (VALUES ('study_human'), ('organization_id')) AS c(col)
 WHERE g.grant_number = 'U01MH143789'
   AND NOT EXISTS (SELECT 1 FROM public.field_provenance fp
                    WHERE fp.entity_table = 'projects' AND fp.entity_id = p.id
                      AND fp.entity_column = c.col AND fp.source_class = 'funder_notice');

-- ── 8. Verify ───────────────────────────────────────────────────────────────────────────
SELECT g.grant_number, g.title, g.fiscal_year, g.reporter_project_num,
       i.name, i.email, gi.role AS roster_role, gi.role_source,
       i.onboarding_completed_at
  FROM public.grant_investigators gi
  JOIN public.grants g        ON g.id = gi.grant_id
  JOIN public.investigators i ON i.id = gi.investigator_id
 WHERE g.grant_number = 'U01MH143789';

-- pi@ derives from the roster (#283) — expect Suthana.
SELECT 'pi_group_eligible' AS check, i.name
  FROM public.grant_investigators gi
  JOIN public.investigators i ON i.id = gi.investigator_id
  JOIN public.grants g        ON g.id = gi.grant_id
 WHERE g.grant_number = 'U01MH143789'
   AND gi.role IN ('PI', 'contact_pi', 'co_pi', 'mpi');

SELECT p.grant_number, o.name AS institution, p.study_human,
       (SELECT count(*) FROM public.grant_investigators gi WHERE gi.grant_id = p.grant_id) AS roster
  FROM public.projects p
  LEFT JOIN public.organizations o ON o.id = p.organization_id
 WHERE p.grant_number = 'U01MH143789';

-- Expect 2 grants + 2 roster + 2 projects = 6 funder_notice claims for this award's new rows.
SELECT fp.entity_table, count(*) AS claims
  FROM public.field_provenance fp
 WHERE fp.source_class = 'funder_notice'
   AND fp.source_ref LIKE 'email:lizzy.ankudowich@nih.gov 2026-09-10%'
 GROUP BY fp.entity_table
 ORDER BY fp.entity_table;
