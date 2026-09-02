-- Record the funder_notice claims for R61MH142354. Nothing recorded them, for two reasons:
--
--   1. trg_enforce_field_provenance is BEFORE UPDATE (20260820150000, provenance_attach_guard).
--      Every cell of a NEW record is written by INSERT, so a brand-new grant, project, person or
--      roster row starts with zero claims. The first claim about a value — where it came from when
--      it was created — is the one the system never captures.
--   2. 20260822150000 derives claims from identifiers (a grants row with reporter_project_num), but
--      it is a one-time backfill INSERT, not a view, and this award postdates it. Its own
--      reporter_project_num is NULL by design, so nothing would derive anyway.
--
-- Same shape as 20260822150000, which is the established way to state a claim about a value that
-- already exists. Nothing here rewrites a value.
--
-- Apply MANUALLY in the KG SQL editor.

SELECT public.set_actor('migration:20260831_r61mh142354_provenance');

INSERT INTO public.field_provenance (
  entity_table, entity_id, entity_column, source_class, activity,
  agent_label, source_ref, value_text, evidence, authored_at, authored_at_precision)
-- The award itself
SELECT 'grants', g.id, c.col, 'funder_notice', 'funder_award_notice',
       'Elizabeth Ankudowich, NIMH (BBQS Co-Lead)',
       'msgid:SA1PR09MB122800FA144E57742259D68A798A92@SA1PR09MB12280.namprd09.prod.outlook.com',
       CASE c.col WHEN 'title' THEN g.title ELSE g.fiscal_year::text END,
       'Introduction of the R61MH142354 team to the BBQS consortium by the NIMH program officer, DKIM-verified from nih.gov.',
       timestamptz '2026-08-31 12:26:09+00', 'exact'
  FROM public.grants g
  CROSS JOIN (VALUES ('title'), ('fiscal_year')) AS c(col)
 WHERE g.grant_number = 'R61MH142354'

UNION ALL
-- Who is on it, and in what role. The roster is what pi@ derives from (#283).
SELECT 'grant_investigators', gi.id, c.col, 'funder_notice', 'funder_award_notice',
       'Elizabeth Ankudowich, NIMH (BBQS Co-Lead)',
       'msgid:SA1PR09MB122800FA144E57742259D68A798A92@SA1PR09MB12280.namprd09.prod.outlook.com',
       CASE c.col WHEN 'role' THEN gi.role ELSE gi.role_source END,
       'Named as an MPI on R61MH142354; Meister confirmed contact PI in the same officer''s reply of 2026-08-31.',
       timestamptz '2026-08-31 12:26:09+00', 'exact'
  FROM public.grant_investigators gi
  JOIN public.grants g ON g.id = gi.grant_id
  CROSS JOIN (VALUES ('role'), ('role_source')) AS c(col)
 WHERE g.grant_number = 'R61MH142354'

UNION ALL
-- The people. Names and addresses came from the notice's own To/CC line.
SELECT 'investigators', i.id, c.col, 'funder_notice', 'funder_award_notice',
       'Elizabeth Ankudowich, NIMH (BBQS Co-Lead)',
       'msgid:SA1PR09MB122800FA144E57742259D68A798A92@SA1PR09MB12280.namprd09.prod.outlook.com',
       CASE c.col WHEN 'name' THEN i.name WHEN 'email' THEN i.email ELSE i.institution END,
       'Surname and address from the award notice; full name confirmed against this person''s other NIH awards in RePORTER.',
       timestamptz '2026-08-31 12:26:09+00', 'exact'
  FROM public.investigators i
  JOIN public.grant_investigators gi ON gi.investigator_id = i.id
  JOIN public.grants g ON g.id = gi.grant_id
  CROSS JOIN (VALUES ('name'), ('email'), ('institution')) AS c(col)
 WHERE g.grant_number = 'R61MH142354'

UNION ALL
-- The project row. study_human is read off the award title, so the title IS the evidence.
SELECT 'projects', p.id, c.col, 'funder_notice', 'funder_award_notice',
       'Elizabeth Ankudowich, NIMH (BBQS Co-Lead)',
       'msgid:SA1PR09MB122800FA144E57742259D68A798A92@SA1PR09MB12280.namprd09.prod.outlook.com',
       CASE c.col WHEN 'study_human' THEN p.study_human::text ELSE p.organization_id::text END,
       'Awardee institution is the contact PI''s (Caltech); study_human from the title: "...recordings in humans during unstructured behavior".',
       timestamptz '2026-08-31 12:26:09+00', 'exact'
  FROM public.projects p
  CROSS JOIN (VALUES ('study_human'), ('organization_id')) AS c(col)
 WHERE p.grant_number = 'R61MH142354';

-- Expect 2 grants + 8 roster + 12 investigators + 2 projects = 24 claims.
SELECT entity_table, count(*) AS claims
  FROM public.field_provenance
 WHERE source_class = 'funder_notice'
 GROUP BY entity_table
 ORDER BY entity_table;
