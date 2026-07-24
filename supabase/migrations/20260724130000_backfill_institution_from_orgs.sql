-- Backfill investigators.institution (the scalar the agent + investigator_directory read)
-- from linked organizations (investigator_organizations), where the scalar is blank.
-- Fixes rows where institution was set only via the pane's org-link editor (e.g. Nima
-- Dehghani: MIT linked, institution=null). Only fills blanks — never clobbers an existing
-- (onboarding-set) value. Run in the KG SQL editor.
UPDATE public.investigators i
SET institution = sub.names
FROM (
  SELECT io.investigator_id,
         string_agg(o.name, ', ' ORDER BY o.name) AS names
  FROM public.investigator_organizations io
  JOIN public.organizations o ON o.id = io.organization_id
  GROUP BY io.investigator_id
) sub
WHERE i.id = sub.investigator_id
  AND (i.institution IS NULL OR btrim(i.institution) = '');
