-- Populate project_publications from RePORTER, then keep it current on a cron.
--
-- project_publications held 2 rows against 45 publications and 32 projects, which is why
-- nih-grants was fetching publications live on every page load. Run STEP 1, verify with STEP 2,
-- and only then deploy the nih-grants change that reads from the KG — deploying first drops the
-- Projects page publication count from 76 to 2.
--
-- One invoke per grant rather than one for all 32: each grant costs a RePORTER call plus PubMed
-- and iCite lookups, and the whole set does not fit in an edge function's wall clock. pg_net is
-- fire-and-forget, so these run concurrently. The import is idempotent — re-run freely.
--
-- Apply MANUALLY in the KG SQL editor.

SELECT public.set_actor('migration:20260831_import_publications');

-- ── STEP 1 ─────────────────────────────────────────────────────────────────
DO $do$
DECLARE _g text; _n int := 0;
BEGIN
  FOR _g IN SELECT grant_number FROM public.projects WHERE grant_number IS NOT NULL ORDER BY 1
  LOOP
    PERFORM public.cron_invoke(
      'import-grant-publications',
      jsonb_build_object('grant_number', _g),
      NULL,
      120000
    );
    _n := _n + 1;
  END LOOP;
  RAISE NOTICE 'Dispatched % import jobs. Wait ~1 min, then run STEP 2.', _n;
END
$do$;

-- ── STEP 2 — run separately, after the jobs land ───────────────────────────
-- Expect project_publications well above 2, and every grant the Projects page shows a count for.
SELECT (SELECT count(*) FROM public.project_publications) AS links,
       (SELECT count(*) FROM public.publications)         AS publications,
       (SELECT count(DISTINCT project_id) FROM public.project_publications) AS projects_covered,
       (SELECT count(*) FROM public.projects)             AS projects_total;

SELECT p.grant_number, count(pp.id) AS pubs
  FROM public.projects p
  LEFT JOIN public.project_publications pp ON pp.project_id = p.id
 GROUP BY p.grant_number
 ORDER BY pubs DESC, p.grant_number;

-- ── STEP 3 — only after STEP 2 looks right, and after deploying nih-grants ─
-- Weekly refresh. Without it the KG copy goes stale and the page silently shows old counts.
-- SELECT cron.schedule('import-publications-weekly', '0 5 * * 1',
--   $cron$SELECT public.cron_invoke('import-grant-publications', '{}'::jsonb, NULL, 120000);$cron$);
