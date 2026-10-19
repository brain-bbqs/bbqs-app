-- R61MH142354 is now on NIH RePORTER (1R61MH142354-01, confirmed 2026-09-08). The grant-level fields
-- (abstract, award_amount, nih_link, reporter_project_num) are now filled by the
-- refresh_grant_from_reporter MCP tool -- run 2026-09-09, no SQL needed for those.
--
-- Still missing: all four MPIs' reporter_profile_id (Yue in particular was noted as having none --
-- he does: RePORTER lists him as co-PI, profile_id 14376679). reporter-pi-sync's `link` action would
-- anchor these automatically, but it isn't exposed as an MCP tool yet, so this fills them directly.
--
-- Roster/roles are NOT touched: RePORTER's contact_pi/co_pi split collapses the funder notice's
-- 4-way MPI structure (Meister contact_pi, Perona/Rutishauser/Yue mpi) to co_pi for the other three,
-- and grant-sync.ts's syncReporterPis never demotes an existing PI-like role -- this migration
-- mirrors that by leaving grant_investigators alone.
--
-- Apply MANUALLY in the KG SQL editor.

SELECT public.set_actor('migration:20260908_r61mh142354_now_on_reporter');
SELECT public.set_source_class('authoritative_registry');

-- ── Anchor reporter_profile_id now that RePORTER lists all four MPIs ──────────
UPDATE public.investigators SET reporter_profile_id = 1896907  WHERE email = 'meister@caltech.edu';
UPDATE public.investigators SET reporter_profile_id = 9852234  WHERE email = 'perona@caltech.edu';
UPDATE public.investigators SET reporter_profile_id = 12046862 WHERE email = 'rutishauseru@csmc.edu';
UPDATE public.investigators SET reporter_profile_id = 14376679 WHERE email = 'yyue@caltech.edu';

-- ── Verify ─────────────────────────────────────────────────────────────────
SELECT name, email, reporter_profile_id
  FROM public.investigators
 WHERE email IN ('meister@caltech.edu', 'perona@caltech.edu', 'rutishauseru@csmc.edu', 'yyue@caltech.edu')
 ORDER BY name;

SELECT entity_table, entity_column, source_class, agent_label
  FROM public.field_provenance
 WHERE recorded_at > now() - interval '5 minutes'
   AND source_class = 'authoritative_registry'
 ORDER BY entity_table, entity_column;
