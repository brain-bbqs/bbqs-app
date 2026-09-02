-- The projects row for R61MH142354, which 20260831120000 did not create.
--
-- Caltech is the awardee institution (contact PI Meister); Cedars-Sinai is Rutishauser's, held as
-- a second organization for the investigator link, not the project. Neither existed in
-- organizations (35 rows, checked 2026-08-31). Names are upper-case to match how nih-grants writes
-- RePORTER's org_name, so this row and a later RePORTER sync collapse to one org rather than two.
--
-- study_human from the award title: "...recordings in humans during unstructured behavior".
--
-- The Projects page will still show "Unknown" after this: institution is read from the nih-grants
-- (RePORTER) response, not the KG. See useMarrProjects.ts:260.
--
-- Apply MANUALLY in the KG SQL editor.

SELECT public.set_actor('migration:20260831_r61mh142354_project_row');
SELECT public.set_source_class('funder_notice');

INSERT INTO public.organizations (name)
SELECT v.name FROM (VALUES
  ('CALIFORNIA INSTITUTE OF TECHNOLOGY'),
  ('CEDARS-SINAI MEDICAL CENTER')
) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM public.organizations o WHERE lower(btrim(o.name)) = lower(btrim(v.name))
);

INSERT INTO public.projects (grant_id, grant_number, organization_id, study_human)
SELECT g.id, g.grant_number, o.id, true
  FROM public.grants g
  CROSS JOIN LATERAL (
    SELECT id FROM public.organizations
     WHERE lower(btrim(name)) = 'california institute of technology' LIMIT 1
  ) o
 WHERE g.grant_number = 'R61MH142354'
   AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.grant_id = g.id);

-- Link each MPI to their own institution.
INSERT INTO public.investigator_organizations (investigator_id, organization_id)
SELECT i.id, o.id
  FROM public.investigators i
  JOIN public.organizations o
    ON lower(btrim(o.name)) = lower(btrim(i.institution))
 WHERE lower(btrim(i.email)) IN ('meister@caltech.edu', 'perona@caltech.edu',
                                 'rutishauseru@csmc.edu', 'yyue@caltech.edu')
ON CONFLICT DO NOTHING;

SELECT p.grant_number, o.name AS institution, p.study_human,
       (SELECT count(*) FROM public.grant_investigators gi WHERE gi.grant_id = p.grant_id) AS roster
  FROM public.projects p
  LEFT JOIN public.organizations o ON o.id = p.organization_id
 WHERE p.grant_number = 'R61MH142354';
