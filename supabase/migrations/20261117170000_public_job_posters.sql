-- public_job_posters: who posted each job, as a link between two spine rows.
--
-- Why. A job's poster is public now (2026-11-17), so the knowledge graph can answer CQ37 ("Who
-- posted each job?") from the anon export. public_jobs deliberately has no posted_by: it is an auth
-- user id, hidden from anon with the contact fields by 20260515233153, and it stays hidden. This view
-- gives the poster as their investigator SPINE row (resources.id), which the anon export already
-- has as a node, and nothing else: no auth user id, no email, no contact field. A job is listed only
-- when both ends exist: the job has a 'job' spine row, and its posted_by is the user_id of an
-- investigator with an 'investigator' spine row.
--
-- Apply by hand: paste the whole file into the SQL editor for vpexxhfpvghlejljwpvt and run it once.
-- Running it again changes nothing. The last statement reports how many jobs got a poster link.
-- Undo: DROP VIEW IF EXISTS public.public_job_posters;  -- nothing depends on it; the exporter then
-- writes no posted_by and says so.

SELECT public.set_actor('migration:public_job_posters');

-- CREATE OR REPLACE VIEW cannot change the columns of an existing view (42P16). So a
-- public_job_posters with other columns is dropped first, without CASCADE: if anything depends on
-- it, the script stops and changes nothing. Something else of that name also stops it.
DO $guard$
DECLARE
  _kind "char";
  _cols text;
BEGIN
  SELECT c.relkind,
         string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
    INTO _kind, _cols
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.relname = 'public_job_posters'
   GROUP BY c.relkind;
  IF _kind IS NULL THEN
    RETURN;
  ELSIF _kind <> 'v' THEN
    RAISE EXCEPTION 'public.public_job_posters exists and is not a view (relkind %): not touched', _kind;
  ELSIF _cols IS DISTINCT FROM 'job_resource_id uuid, poster_resource_id uuid' THEN
    DROP VIEW public.public_job_posters;
    RAISE NOTICE 'public.public_job_posters had columns (%): dropped, recreated below', _cols;
  END IF;
END
$guard$;

-- Owner rights (security_invoker = false), as investigators_public: anon cannot read jobs or
-- investigators, and reads only these two columns.
CREATE OR REPLACE VIEW public.public_job_posters
WITH (security_invoker = false) AS
SELECT DISTINCT j.resource_id AS job_resource_id,
                i.resource_id AS poster_resource_id
  FROM public.jobs j
  JOIN public.resources jr    ON jr.id = j.resource_id AND jr.resource_type = 'job'
  JOIN public.investigators i ON i.user_id = j.posted_by
  JOIN public.resources ir    ON ir.id = i.resource_id AND ir.resource_type = 'investigator';

COMMENT ON VIEW public.public_job_posters IS
  'Who posted each job: the job''s spine row -> the poster''s investigator spine row (jobs.posted_by = '
  'investigators.user_id). Public (20261117170000); exposes no auth user id, email or contact field.';

-- Read only. Supabase's default privileges give anon and authenticated every privilege on a new view.
REVOKE ALL ON public.public_job_posters FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.public_job_posters TO anon, authenticated;

-- ── Report (read-only) ──────────────────────────────────────────────────────────────────────────
-- with_a_poster_link is what the export can write. The next three say why a job has none (a job can
-- have more than one reason): poster_not_linked means a poster is recorded but is no investigator
-- with a spine row (or the job's spine row is not typed 'job'). with_more_than_one_poster counts jobs
-- whose poster's user id is on two investigator rows: a duplicate person to merge.
SELECT count(*)                                                    AS jobs,
       count(*) FILTER (WHERE p.job_resource_id IS NOT NULL)       AS with_a_poster_link,
       count(*) FILTER (WHERE j.resource_id IS NULL)               AS no_spine_row,
       count(*) FILTER (WHERE j.posted_by IS NULL)                 AS no_poster_recorded,
       count(*) FILTER (WHERE j.resource_id IS NOT NULL AND j.posted_by IS NOT NULL
                          AND p.job_resource_id IS NULL)           AS poster_not_linked,
       count(*) FILTER (WHERE p.posters > 1)                       AS with_more_than_one_poster
  FROM public.jobs j
  LEFT JOIN (SELECT job_resource_id, count(*) AS posters
               FROM public.public_job_posters GROUP BY job_resource_id) p
         ON p.job_resource_id = j.resource_id;
