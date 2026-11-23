-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261117190000_hide_private_columns_from_anon.sql
-- SECURITY: anonymous visitors could read e-mail addresses, auth user ids, pending role requests and
-- curators' review notes. Take those columns away from anon. Every public column stays readable, and
-- signed-in users keep exactly what they had.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHY. Anyone holding the site's public key acts as anon. Supabase's default privileges grant anon
-- SELECT on every table and view; row-level security decides which ROWS a table shows, and a view
-- with its owner's rights (investigators_public, feature_suggestions_public) shows every row of its
-- base table. Nothing decided which COLUMNS anon may see. An audit of every table and view anon can
-- read (2026-11-17, on a replica of this schema with a planted value per column) found, under
-- SET ROLE anon:
--   investigators_public        user_id (the auth login id, the key that turns every other user id
--                               into a name) and pending_role (who has asked to be curator or admin)
--   projects                    last_edited_by (e-mail addresses: import_questionnaire_response writes
--                               the respondent's, add-project-by-grant the editor's) and, inside
--                               metadata, questionnaire_submitted_by (the respondent's e-mail),
--                               questionnaire_submitted_at and questionnaire_response_id
--   project_questionnaire_status the same three. 20260811140000 meant it for signed-in curators
--                               (GRANT ... TO authenticated); Supabase's default grant gave anon too
--   resources.created_by, announcements.posted_by, entity_comments.user_id,
--   harvester_relations.approved_by, harvester_settings.updated_by, dandisets.hidden_by: auth user ids
--   dandisets                   hidden_reason and hidden_at (a curator's decision on a test upload),
--                               raw (EMBER's whole metadata payload, contributor e-mail addresses in it)
--   feature_suggestions_public  submitter_name and github_username. 20260515233153 built this view to
--                               hide the submitter; 20260813185734 put both back.
--
-- WHAT.
--   1. Column grants. On each object above, anon loses table-level SELECT and is granted SELECT on
--      every column it could read before except the private ones. authenticated and service_role are
--      not touched. A column added to one of these objects LATER is not readable by anon until a
--      migration grants it: GRANT SELECT (<column>) ON public.<object> TO anon.
--   2. project_questionnaire_status: anon loses SELECT. Signed-in curators read it as before.
--   3. The questionnaire attribution leaves the public metadata blob. Three columns on projects hold
--      it (questionnaire_submitted_by, questionnaire_submitted_at, questionnaire_response_id), and anon
--      cannot read them. A trigger moves the three keys out of metadata on every insert and update, so
--      no writer can put them back: not import_questionnaire_response, which still writes them into
--      metadata, not a hand-written import like 20260810140000, not a profile page saving a stale copy.
--      The first recorded submission wins, as the import function always had it.
--      project_questionnaire_status reads the columns.
--
-- READERS (checked 2026-11-17). PostgREST runs select=* as SELECT *, which needs every column, so
-- each anon read of these objects that named no columns now names them, in the same change:
-- PrincipalInvestigators, InvestigatorSummary, GrantSummary, ResourceSummary, GenericSummary,
-- useResources, useProjectProfileEditor, Announcements, EmberDandisetsPanel, FeatureSuggestions and
-- EntityComments (submitter and user_id only for signed-in viewers), kg/bbqs_kg.py and kg/roundtrip.py
-- (PUBLIC_COLUMNS), e2e/data.spec.ts. None of them shows a private column to a visitor. The edge
-- functions read these objects as service_role or name public columns (_shared/kg.ts). The new lists
-- work before this is applied as well as after. tests/guards/anon-private-columns holds src/ and kg/
-- to it: no select=* on these objects, and no private column in an anon read.
--
-- CHECK FIRST (read-only; which private columns anon can read today, and how many projects carry the
-- attribution in metadata):
--   SELECT v.obj AS object, a.attname AS private_column,
--          has_column_privilege('anon', c.oid, a.attnum, 'SELECT') AS anon_can_read
--     FROM (VALUES ('investigators_public', '{user_id,pending_role}'::text[]),
--                  ('feature_suggestions_public', '{submitter_name,github_username}'),
--                  ('project_questionnaire_status', '{submitted_by,submitted_at,response_id,owner_email}'),
--                  ('projects', '{last_edited_by}'), ('resources', '{created_by}'),
--                  ('announcements', '{posted_by}'), ('entity_comments', '{user_id}'),
--                  ('dandisets', '{raw,hidden_reason,hidden_by,hidden_at}'),
--                  ('harvester_relations', '{approved_by}'), ('harvester_settings', '{updated_by}')) v(obj, cols)
--     JOIN pg_class c ON c.relname = v.obj AND c.relnamespace = 'public'::regnamespace
--     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = ANY (v.cols) AND NOT a.attisdropped
--   UNION ALL
--   SELECT 'projects', 'metadata: questionnaire_submitted_by/_at/_response_id on ' || count(*) || ' rows',
--          has_column_privilege('anon', 'public.projects', 'metadata', 'SELECT')
--     FROM public.projects
--    WHERE metadata ?| ARRAY['questionnaire_submitted_by', 'questionnaire_submitted_at', 'questionnaire_response_id']
--    ORDER BY 1, 2;
--
-- HOW TO APPLY: Supabase SQL editor, project vpexxhfpvghlejljwpvt, as its default role (postgres).
-- Paste the WHOLE file, Run: one transaction, and a second run changes nothing. It refuses to commit
-- if anon could still read a private column, if anon would lose a public one, or if signed-in users'
-- access would change. The last statement reports, per object, what anon could read before and what
-- it may read now.
-- UNDO one column, if a public reader turns out to need it: GRANT SELECT (<column>) ON public.<object>
-- TO anon. Everything: GRANT SELECT ON public.<object> TO anon for each object, and the same for
-- project_questionnaire_status. The attribution stays in its columns either way.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

SELECT public.set_actor('migration:hide_private_columns_from_anon');

-- ── 0. Preconditions: stop, changing nothing, on a schema this was not written for ──────────────
DO $guard$
DECLARE
  _bad  text;
  _have text[];
  _want text[] := ARRAY['grant_id', 'grant_number', 'grant_title', 'project_id', 'fields_filled',
                        'fields_total', 'pct', 'missing_fields', 'status', 'submitted_by', 'submitted_at',
                        'response_id', 'submitter_standing', 'owner_name', 'owner_email', 'form_url',
                        'responses_url', 'answers'];
BEGIN
  IF to_regclass('public.projects') IS NULL OR to_regclass('public.grants') IS NULL THEN
    RAISE EXCEPTION 'public.projects or public.grants is missing: this is not the KG database';
  END IF;

  -- A second run finds the attribution columns made by the first; anything else of that name stops it.
  SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ')
    INTO _bad
    FROM pg_attribute a
    JOIN (VALUES ('questionnaire_submitted_by', 'text'),
                 ('questionnaire_submitted_at', 'timestamp with time zone'),
                 ('questionnaire_response_id',  'text')) w(name, type) ON w.name = a.attname
   WHERE a.attrelid = 'public.projects'::regclass AND NOT a.attisdropped
     AND format_type(a.atttypid, a.atttypmod) <> w.type;
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'public.projects already has %, not the text / timestamptz / text made here: nothing changed', _bad;
  END IF;

  -- project_questionnaire_status is redefined in section 3. Postgres lets a redefinition only APPEND
  -- columns (42P16), so the live list must be a prefix of the new one. The live view may lack the last
  -- two, responses_url and answers (types.ts has neither); they are appended then.
  IF to_regclass('public.project_questionnaire_status') IS NULL THEN
    RAISE EXCEPTION 'public.project_questionnaire_status is missing: apply 20260811140000 first';
  END IF;
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO _have
    FROM pg_attribute a
   WHERE a.attrelid = 'public.project_questionnaire_status'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF cardinality(_have) > cardinality(_want) OR _have <> _want[1:cardinality(_have)] THEN
    RAISE EXCEPTION 'public.project_questionnaire_status has the columns (%), which (%) does not extend: nothing changed',
      array_to_string(_have, ', '), array_to_string(_want, ', ');
  END IF;
END
$guard$;

-- ── 1. What is private, and what anon and signed-in users may read before this run ──────────────
-- The one list of private columns. Sections 4 and 5 and the report read it, and
-- tests/guards/anon-private-columns.test.mjs reads it from this file.
DROP TABLE IF EXISTS pg_temp.kg_private_from_anon;
CREATE TEMP TABLE kg_private_from_anon (object_name text, column_name text, holds text);
INSERT INTO kg_private_from_anon (object_name, column_name, holds) VALUES
  ('investigators_public',       'user_id',                    'auth user id'),
  ('investigators_public',       'pending_role',               'a role request awaiting review'),
  ('feature_suggestions_public', 'submitter_name',             'the submitter''s name'),
  ('feature_suggestions_public', 'github_username',            'the submitter''s GitHub login'),
  ('projects',                   'last_edited_by',             'e-mail address, auth user id or actor label'),
  ('projects',                   'questionnaire_submitted_by', 'the respondent''s e-mail address'),
  ('projects',                   'questionnaire_submitted_at', 'when the questionnaire was submitted'),
  ('projects',                   'questionnaire_response_id',  'the Google Forms response id'),
  ('resources',                  'created_by',                 'auth user id'),
  ('announcements',              'posted_by',                  'auth user id'),
  ('entity_comments',            'user_id',                    'auth user id'),
  ('dandisets',                  'raw',                        'EMBER''s metadata payload, contributor e-mail addresses included'),
  ('dandisets',                  'hidden_reason',              'a curator''s note on why a dataset is hidden'),
  ('dandisets',                  'hidden_by',                  'auth user id'),
  ('dandisets',                  'hidden_at',                  'when a curator hid it'),
  ('harvester_relations',        'approved_by',                'auth user id'),
  ('harvester_settings',         'updated_by',                 'auth user id');

DROP TABLE IF EXISTS pg_temp.kg_read_before;
CREATE TEMP TABLE kg_read_before AS
SELECT c.relname::text AS object_name, a.attnum, a.attname::text AS column_name,
       has_column_privilege('anon', c.oid, a.attnum, 'SELECT')          AS anon_could,
       has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT') AS authenticated_could
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.relname IN (SELECT object_name FROM pg_temp.kg_private_from_anon
                     UNION SELECT 'project_questionnaire_status');

DROP TABLE IF EXISTS pg_temp.kg_attribution_before;
CREATE TEMP TABLE kg_attribution_before AS
SELECT count(*) AS projects
  FROM public.projects
 WHERE metadata ?| ARRAY['questionnaire_submitted_by', 'questionnaire_submitted_at', 'questionnaire_response_id'];

-- ── 2. The questionnaire attribution moves out of metadata, into columns anon cannot read ───────
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS questionnaire_submitted_by text,
  ADD COLUMN IF NOT EXISTS questionnaire_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS questionnaire_response_id  text;

COMMENT ON COLUMN public.projects.questionnaire_submitted_by IS
  'E-mail of whoever submitted the Data Questionnaire this project''s answers came from. Not readable by anon (20261117190000); project_questionnaire_status judges it against the grant roster.';
COMMENT ON COLUMN public.projects.questionnaire_submitted_at IS
  'When that questionnaire response was submitted. Not readable by anon (20261117190000).';
COMMENT ON COLUMN public.projects.questionnaire_response_id IS
  'The Google Forms responseId of that response. Not readable by anon (20261117190000).';

CREATE OR REPLACE FUNCTION public.keep_questionnaire_attribution_private()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  _at text;
BEGIN
  IF NEW.metadata IS NULL OR jsonb_typeof(NEW.metadata) <> 'object'
     OR NOT (NEW.metadata ?| ARRAY['questionnaire_submitted_by', 'questionnaire_submitted_at', 'questionnaire_response_id']) THEN
    RETURN NEW;
  END IF;
  -- The first recorded submission wins: a column that already holds a value keeps it.
  IF nullif(btrim(coalesce(NEW.questionnaire_submitted_by, '')), '') IS NULL THEN
    NEW.questionnaire_submitted_by := nullif(btrim(coalesce(NEW.metadata ->> 'questionnaire_submitted_by', '')), '');
  END IF;
  IF nullif(btrim(coalesce(NEW.questionnaire_response_id, '')), '') IS NULL THEN
    NEW.questionnaire_response_id := nullif(btrim(coalesce(NEW.metadata ->> 'questionnaire_response_id', '')), '');
  END IF;
  IF NEW.questionnaire_submitted_at IS NULL THEN
    _at := nullif(btrim(coalesce(NEW.metadata ->> 'questionnaire_submitted_at', '')), '');
    IF _at IS NOT NULL THEN
      BEGIN
        NEW.questionnaire_submitted_at := _at::timestamptz;
      EXCEPTION WHEN data_exception THEN
        RAISE WARNING 'projects %: questionnaire_submitted_at "%" is not a timestamp; not kept', NEW.id, _at;
      END;
    END IF;
  END IF;
  NEW.metadata := NEW.metadata - 'questionnaire_submitted_by' - 'questionnaire_submitted_at'
                               - 'questionnaire_response_id';
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.keep_questionnaire_attribution_private() IS
  'BEFORE INSERT OR UPDATE OF metadata on projects: moves questionnaire_submitted_by/_at/_response_id out of the public metadata blob into the projects columns of those names, which anon cannot read (20261117190000). A column already holding a value keeps it.';

-- trg_aa_ sorts first, so the provenance guard and the audit log see the row as it is stored.
CREATE OR REPLACE TRIGGER trg_aa_keep_questionnaire_attribution_private
  BEFORE INSERT OR UPDATE OF metadata ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.keep_questionnaire_attribution_private();

-- Move what is there now. The trigger does the moving; this touches each such row once. The values
-- came from the questionnaire, so their new cells are recorded at that source.
SELECT public.set_source_class('questionnaire');
UPDATE public.projects
   SET metadata = metadata
 WHERE metadata ?| ARRAY['questionnaire_submitted_by', 'questionnaire_submitted_at', 'questionnaire_response_id'];
SELECT public.set_source_class('');

-- ── 3. project_questionnaire_status reads the columns, and only signed-in users may read it ─────
-- The link to the form's responses tab is for the admins who can open it, so anon loses it too. Its
-- definition is 20260811140000's, repeated so the view below can rely on it.
CREATE OR REPLACE FUNCTION public.questionnaire_responses_url()
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT 'https://docs.google.com/forms/d/1oQ9R8uEt8IbgY3h5-mSZ821F2dbUQ7efXkeLN8tl-u4/edit#responses'
$fn$;
REVOKE ALL ON FUNCTION public.questionnaire_responses_url() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.questionnaire_responses_url() TO authenticated, service_role;

-- 20260811140000's definition, with the three attribution reads moved from metadata to the columns.
CREATE OR REPLACE VIEW public.project_questionnaire_status
WITH (security_invoker = true)
AS
WITH base AS (
  SELECT g.id           AS grant_id,
         g.grant_number,
         g.title        AS grant_title,
         p.id           AS project_id,
         coalesce(p.metadata, '{}'::jsonb) AS metadata,
         p.study_species,
         p.questionnaire_submitted_by AS q_submitted_by,
         p.questionnaire_submitted_at AS q_submitted_at,
         p.questionnaire_response_id  AS q_response_id
    FROM public.grants g
    LEFT JOIN public.projects p ON p.grant_id = g.id
),
counted AS (
  SELECT b.*,
         (SELECT count(*) FROM unnest(public.questionnaire_fields()) f
           WHERE CASE
                   WHEN f = 'species'
                     THEN coalesce(array_length(b.study_species, 1), 0) > 0
                   ELSE public.jsonb_is_answered(b.metadata -> f)
                 END
         ) AS fields_filled
    FROM base b
)
SELECT c.grant_id,
       c.grant_number,
       c.grant_title,
       c.project_id,
       c.fields_filled,
       array_length(public.questionnaire_fields(), 1) AS fields_total,
       round(100.0 * c.fields_filled / array_length(public.questionnaire_fields(), 1))::int AS pct,
       (SELECT array_agg(f ORDER BY f) FROM unnest(public.questionnaire_fields()) f
         WHERE CASE
                 WHEN f = 'species' THEN coalesce(array_length(c.study_species, 1), 0) = 0
                 ELSE NOT public.jsonb_is_answered(c.metadata -> f)
               END) AS missing_fields,
       CASE
         WHEN c.fields_filled = 0 THEN 'not_started'
         WHEN c.fields_filled < array_length(public.questionnaire_fields(), 1) THEN 'partial'
         ELSE 'complete'
       END AS status,
       c.q_submitted_by AS submitted_by,
       c.q_submitted_at AS submitted_at,
       c.q_response_id  AS response_id,
       -- WHO submitted, judged against THIS grant's roster. Three distinct outcomes, never collapsed.
       CASE
         WHEN c.q_submitted_by IS NULL THEN 'unknown'
         WHEN EXISTS (
           SELECT 1 FROM public.grant_investigators gi
             JOIN public.investigators i ON i.id = gi.investigator_id
            WHERE gi.grant_id = c.grant_id
              AND lower(gi.role) IN ('pi', 'contact_pi', 'co_pi', 'mpi')
              AND (lower(btrim(i.email)) = lower(c.q_submitted_by)
                   OR EXISTS (SELECT 1 FROM unnest(coalesce(i.secondary_emails, '{}')) s
                               WHERE lower(btrim(s)) = lower(c.q_submitted_by)))
         ) THEN 'pi'
         WHEN EXISTS (
           SELECT 1 FROM public.grant_investigators gi
             JOIN public.investigators i ON i.id = gi.investigator_id
            WHERE gi.grant_id = c.grant_id
              AND (lower(btrim(i.email)) = lower(c.q_submitted_by)
                   OR EXISTS (SELECT 1 FROM unnest(coalesce(i.secondary_emails, '{}')) s
                               WHERE lower(btrim(s)) = lower(c.q_submitted_by)))
         ) THEN 'project_member'
         ELSE 'not_on_roster'
       END AS submitter_standing,
       -- Who OWNS it: the questionnaire is contact-PI-owned (migration 20260807140000).
       (SELECT i.name FROM public.grant_investigators gi
          JOIN public.investigators i ON i.id = gi.investigator_id
         WHERE gi.grant_id = c.grant_id AND lower(gi.role) = 'contact_pi'
         ORDER BY i.name LIMIT 1) AS owner_name,
       (SELECT i.email FROM public.grant_investigators gi
          JOIN public.investigators i ON i.id = gi.investigator_id
         WHERE gi.grant_id = c.grant_id AND lower(gi.role) = 'contact_pi'
         ORDER BY i.name LIMIT 1) AS owner_email,
       public.questionnaire_form_url() AS form_url,
       public.questionnaire_responses_url() AS responses_url,
       -- The answers themselves. The attribution keys are no longer in metadata; stripping them stays
       -- so a row written before the trigger existed cannot show them here either.
       (c.metadata - 'questionnaire_submitted_by' - 'questionnaire_submitted_at'
                   - 'questionnaire_response_id') AS answers
  FROM counted c;

COMMENT ON VIEW public.project_questionnaire_status IS
  'Live Data Questionnaire status per grant: fields filled/total and pct computed from the ten canonical fields (NOT the stale metadata_completeness column), the blank field names, and who submitted it (projects.questionnaire_submitted_by) judged against that grant''s roster (pi / project_member / not_on_roster / unknown). security_invoker so projects/grants RLS applies. Signed-in users only (20261117190000).';

REVOKE ALL ON public.project_questionnaire_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.project_questionnaire_status TO authenticated;

-- ── 4. Column grants: anon keeps every column it could read except the private ones ─────────────
DO $hide$
DECLARE
  _o    record;
  _rel  regclass;
  _all  text;
  _keep text;
BEGIN
  FOR _o IN SELECT object_name, array_agg(column_name) AS private
              FROM pg_temp.kg_private_from_anon
             GROUP BY object_name ORDER BY object_name LOOP
    _rel := to_regclass(format('public.%I', _o.object_name));
    IF _rel IS NULL THEN
      RAISE NOTICE '%: not in this database, nothing to hide', _o.object_name;
      CONTINUE;
    END IF;
    -- Computed before this object's REVOKE, so "could read" means could read before this run.
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
           string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
             FILTER (WHERE NOT (a.attname::text = ANY (_o.private))
                       AND has_column_privilege('anon', _rel, a.attnum, 'SELECT'))
      INTO _all, _keep
      FROM pg_attribute a
     WHERE a.attrelid = _rel AND a.attnum > 0 AND NOT a.attisdropped;
    -- PUBLIC too: anon holds whatever PUBLIC holds.
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, PUBLIC', _o.object_name);
    EXECUTE format('REVOKE SELECT (%s) ON public.%I FROM anon, PUBLIC', _all, _o.object_name);
    IF _keep IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO anon', _keep, _o.object_name);
    END IF;
  END LOOP;
END
$hide$;

-- ── 5. Postconditions: refuse to commit a result that hides too little, or too much ─────────────
DO $check$
DECLARE
  _bad text;
BEGIN
  SELECT string_agg(p.object_name || '.' || p.column_name, ', ' ORDER BY p.object_name, p.column_name)
    INTO _bad
    FROM pg_temp.kg_private_from_anon p
    JOIN pg_attribute a ON a.attrelid = to_regclass(format('public.%I', p.object_name))
                       AND a.attname = p.column_name AND NOT a.attisdropped
   WHERE has_column_privilege('anon', a.attrelid, a.attnum, 'SELECT');
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'anon could still read %: nothing committed', _bad;
  END IF;

  IF has_any_column_privilege('anon', 'public.project_questionnaire_status', 'SELECT') THEN
    RAISE EXCEPTION 'anon could still read project_questionnaire_status: nothing committed';
  END IF;

  -- Every other column: anon reads it now exactly when it could before, so nothing public was lost
  -- and nothing was opened.
  SELECT string_agg(b.object_name || '.' || b.column_name
                    || CASE WHEN b.anon_could THEN ' (lost)' ELSE ' (opened)' END, ', ')
    INTO _bad
    FROM pg_temp.kg_read_before b
   WHERE b.object_name <> 'project_questionnaire_status'
     AND NOT EXISTS (SELECT 1 FROM pg_temp.kg_private_from_anon p
                      WHERE p.object_name = b.object_name AND p.column_name = b.column_name)
     AND b.anon_could IS DISTINCT FROM
         has_column_privilege('anon', to_regclass(format('public.%I', b.object_name)), b.column_name, 'SELECT');
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'anon would change on a public column: %; nothing committed', _bad;
  END IF;

  -- Signed-in users: exactly what they had, plus the three new columns (the attribution they could
  -- already read inside metadata).
  SELECT string_agg(b.object_name || '.' || b.column_name, ', ')
    INTO _bad
    FROM pg_temp.kg_read_before b
   WHERE b.authenticated_could IS DISTINCT FROM
         has_column_privilege('authenticated', to_regclass(format('public.%I', b.object_name)), b.column_name, 'SELECT');
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'signed-in users would change on %; nothing committed', _bad;
  END IF;
  IF NOT (has_column_privilege('authenticated', 'public.projects', 'questionnaire_submitted_by', 'SELECT')
          AND has_column_privilege('authenticated', 'public.projects', 'questionnaire_submitted_at', 'SELECT')
          AND has_column_privilege('authenticated', 'public.projects', 'questionnaire_response_id', 'SELECT')) THEN
    RAISE EXCEPTION 'signed-in users could not read the attribution columns: nothing committed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.projects
              WHERE metadata ?| ARRAY['questionnaire_submitted_by', 'questionnaire_submitted_at', 'questionnaire_response_id']) THEN
    RAISE EXCEPTION 'a project still carries the questionnaire attribution in metadata: nothing committed';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';

-- ── Report (the editor shows only this last result) ─────────────────────────────────────────────
-- Per object: how many columns anon could read before this run and may read now, which ones this run
-- took from it (a second run says "none"), every column anon may not read now, and whether signed-in
-- users read the same. The last row: projects whose metadata held the attribution, before and now.
WITH now_cols AS (
  SELECT c.relname::text AS object_name, a.attnum, a.attname::text AS column_name,
         has_column_privilege('anon', c.oid, a.attnum, 'SELECT')          AS anon_can,
         has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT') AS authenticated_can
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.relname IN (SELECT DISTINCT object_name FROM pg_temp.kg_read_before)
),
per AS (
  SELECT o.object_name,
         (SELECT count(*) FILTER (WHERE b.anon_could) FROM pg_temp.kg_read_before b WHERE b.object_name = o.object_name) AS could,
         (SELECT count(*) FROM pg_temp.kg_read_before b WHERE b.object_name = o.object_name) AS cols_before,
         (SELECT count(*) FILTER (WHERE n.anon_can) FROM now_cols n WHERE n.object_name = o.object_name) AS may,
         (SELECT count(*) FROM now_cols n WHERE n.object_name = o.object_name) AS cols_now,
         (SELECT string_agg(b.column_name, ', ' ORDER BY b.attnum)
            FROM pg_temp.kg_read_before b
            JOIN now_cols n ON n.object_name = b.object_name AND n.column_name = b.column_name
           WHERE b.object_name = o.object_name AND b.anon_could AND NOT n.anon_can) AS taken,
         (SELECT string_agg(n.column_name, ', ' ORDER BY n.attnum)
            FROM now_cols n WHERE n.object_name = o.object_name AND NOT n.anon_can) AS refused,
         EXISTS (SELECT 1 FROM pg_temp.kg_read_before b
                   JOIN now_cols n ON n.object_name = b.object_name AND n.column_name = b.column_name
                  WHERE b.object_name = o.object_name AND b.authenticated_could IS DISTINCT FROM n.authenticated_can) AS signed_in_changed,
         (SELECT string_agg(n.column_name, ', ' ORDER BY n.attnum)
            FROM now_cols n
           WHERE n.object_name = o.object_name AND n.authenticated_can
             AND NOT EXISTS (SELECT 1 FROM pg_temp.kg_read_before b
                              WHERE b.object_name = n.object_name AND b.column_name = n.column_name)) AS signed_in_new
    FROM (SELECT DISTINCT object_name FROM pg_temp.kg_read_before) o
)
SELECT object_name AS object,
       could || ' of ' || cols_before || ' columns' AS anon_could_read,
       may || ' of ' || cols_now || ' columns' AS anon_may_read_now,
       CASE WHEN taken IS NULL THEN 'none'
            WHEN may = 0 AND could = cols_before THEN 'every column'
            ELSE taken END AS taken_from_anon_by_this_run,
       CASE WHEN refused IS NULL THEN 'none' WHEN may = 0 THEN 'every column' ELSE refused END AS anon_may_not_read,
       CASE WHEN signed_in_changed THEN 'CHANGED'
            ELSE 'unchanged' || coalesce(' (+ new: ' || signed_in_new || ')', '') END AS signed_in_users
  FROM per
UNION ALL
SELECT 'projects.metadata: questionnaire_submitted_by/_at/_response_id',
       'on ' || (SELECT projects FROM pg_temp.kg_attribution_before) || ' project(s)',
       'on ' || (SELECT count(*) FROM public.projects
                  WHERE metadata ?| ARRAY['questionnaire_submitted_by', 'questionnaire_submitted_at', 'questionnaire_response_id']) || ' project(s)',
       CASE WHEN (SELECT projects FROM pg_temp.kg_attribution_before) > 0
            THEN 'moved to projects.questionnaire_submitted_by / _at / _response_id' ELSE 'none' END,
       'the keys, on every write (trg_aa_keep_questionnaire_attribution_private)',
       (SELECT count(*) FROM public.projects WHERE questionnaire_submitted_by IS NOT NULL) || ' project(s) with a submitter on record'
 ORDER BY 1;
