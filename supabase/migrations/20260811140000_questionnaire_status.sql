-- Deterministic Data Questionnaire status per project — replaces asking the agent.
--
-- THE COMPLAINT. Clicking the `data_questionnaire` stage tag in the onboarding console opened the
-- CHAT AGENT with "What is the data questionnaire status for <email>?". That is the wrong shape for a
-- question with an exact answer: the console already knows the project, and an LLM re-deriving it from
-- a sentence can only be slower and less certain. Worse, the agent's own answer came from
-- `projects.metadata_completeness`, which reads 86 for almost every project regardless of content.
--
-- THE THREE QUESTIONS THIS ANSWERS
--
-- 1. WHICH FORM RESPONSE BELONGS TO WHICH PROJECT?
--    Two signals, in order, both verified against all 21 live responses on 2026-08-11:
--    (a) The form's REQUIRED "Grants" question returns a real grant TITLE, formatted
--        "R34: <grants.title> (PI(s): …)". Stripping the mechanism prefix and the trailing PI list
--        and matching grants.title resolves 16 of 21 to exactly one grant.
--    (b) Otherwise the respondent's email → grant roster, when they are on exactly one grant
--        (covers Wilbrecht, whose title did not match). Total 17 of 21.
--    2 responses select TWO grants (a real multi-grant answer, needs a human) and 2 are NIH program
--    staff on no grant (partial submissions, correctly excluded).
--    The importer records the winner as `metadata.questionnaire_response_id`, so once a response is
--    attributed it stays attributed and cannot be double-imported.
--
-- 2. HOW MUCH IS FILLED?
--    Computed live from the ten canonical fields, NOT from the stored metadata_completeness column.
--    The field list mirrors bbqs-agent QUESTIONNAIRE_FIELDS exactly so the console and the agent can
--    never disagree; `species` is special-cased because it lives in projects.study_species rather
--    than the metadata blob. Emptiness means NULL, '', [] or {} — a key that exists with an empty
--    value is not an answer.
--
-- 3. RELIABLE STATUS FOR PIs
--    Per project: fields filled/total, percent, status, and WHO submitted it — with the submitter
--    checked against that grant's roster, so the answer distinguishes
--      submitted by a PI  ·  submitted by a project member  ·  submitter not on the roster
--    instead of collapsing all three into one tick. Before this, `projects.metadata` held 84 content
--    keys and no record of who answered at all.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260811140000');

/** The ten canonical questionnaire fields. Kept as a function so both the view and any caller read
 *  one definition; mirrors bbqs-agent src/server/tools/read-tools.ts QUESTIONNAIRE_FIELDS. */
CREATE OR REPLACE FUNCTION public.questionnaire_fields()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    'species',                      -- special-cased: projects.study_species, not metadata
    'data_types_collected',
    'produce_data_modality',
    'behavioral_data_formats',
    'primary_storage',
    'data_management_systems',
    'data_sync_methods',
    'analysis_software',
    'persistent_identifiers',
    'all_data_public_immediately'
  ]
$fn$;

/** Is this jsonb value a real answer? A present-but-empty key is not one. */
CREATE OR REPLACE FUNCTION public.jsonb_is_answered(_v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN _v IS NULL OR _v = 'null'::jsonb THEN false
    WHEN jsonb_typeof(_v) = 'string'  THEN btrim(_v #>> '{}') <> ''
    WHEN jsonb_typeof(_v) = 'array'   THEN jsonb_array_length(_v) > 0
    WHEN jsonb_typeof(_v) = 'object'  THEN _v <> '{}'::jsonb
    ELSE true                       -- numbers and booleans are answers, including false
  END
$fn$;


/** The live responder URL for the BBQS Data Questionnaire.
 *
 *  Verified against the Forms API on 2026-08-11: form
 *  1oQ9R8uEt8IbgY3h5-mSZ821F2dbUQ7efXkeLN8tl-u4 reports this responderUri. Two forms.gle short links
 *  are in circulation (zTNq5yijMgPVay4dA in the agent's consortium_settings default, and
 *  7JUR5xR9iVgFm41P7 in the PI onboarding email) and BOTH resolve here, so neither is wrong — but a
 *  short link hides which form it points at, and this one does not.
 *
 *  A function rather than a hardcoded string in the React component, so the console, the agent and any
 *  reminder read one definition and a new form is a one-line migration instead of a grep. */
CREATE OR REPLACE FUNCTION public.questionnaire_form_url()
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT 'https://docs.google.com/forms/d/e/1FAIpQLSd-L-B74LRv3z1hT964nVpN5uLcsP-D1VCzHwqkw9nCGdtCyw/viewform'
$fn$;

GRANT EXECUTE ON FUNCTION public.questionnaire_form_url() TO authenticated, service_role;

CREATE OR REPLACE VIEW public.project_questionnaire_status
WITH (security_invoker = true)
AS
WITH base AS (
  SELECT g.id           AS grant_id,
         g.grant_number,
         g.title        AS grant_title,
         p.id           AS project_id,
         coalesce(p.metadata, '{}'::jsonb) AS metadata,
         p.study_species
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
       -- Which of the ten are still blank: the actionable part, so a reminder can name them.
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
       c.metadata ->> 'questionnaire_submitted_by' AS submitted_by,
       (c.metadata ->> 'questionnaire_submitted_at')::timestamptz AS submitted_at,
       c.metadata ->> 'questionnaire_response_id'  AS response_id,
       -- WHO submitted, judged against THIS grant's roster. Three distinct outcomes, never collapsed.
       CASE
         WHEN c.metadata ->> 'questionnaire_submitted_by' IS NULL THEN 'unknown'
         WHEN EXISTS (
           SELECT 1 FROM public.grant_investigators gi
             JOIN public.investigators i ON i.id = gi.investigator_id
            WHERE gi.grant_id = c.grant_id
              AND lower(gi.role) IN ('pi', 'contact_pi', 'co_pi', 'mpi')
              AND (lower(btrim(i.email)) = lower(c.metadata ->> 'questionnaire_submitted_by')
                   OR EXISTS (SELECT 1 FROM unnest(coalesce(i.secondary_emails, '{}')) s
                               WHERE lower(btrim(s)) = lower(c.metadata ->> 'questionnaire_submitted_by')))
         ) THEN 'pi'
         WHEN EXISTS (
           SELECT 1 FROM public.grant_investigators gi
             JOIN public.investigators i ON i.id = gi.investigator_id
            WHERE gi.grant_id = c.grant_id
              AND (lower(btrim(i.email)) = lower(c.metadata ->> 'questionnaire_submitted_by')
                   OR EXISTS (SELECT 1 FROM unnest(coalesce(i.secondary_emails, '{}')) s
                               WHERE lower(btrim(s)) = lower(c.metadata ->> 'questionnaire_submitted_by')))
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
       public.questionnaire_form_url() AS form_url
  FROM counted c;

COMMENT ON VIEW public.project_questionnaire_status IS
  'Live Data Questionnaire status per grant: fields filled/total and pct computed from the ten canonical fields (NOT the stale metadata_completeness column), the blank field names, and who submitted it judged against that grant''s roster (pi / project_member / not_on_roster / unknown). security_invoker so projects/grants RLS applies.';

GRANT SELECT ON public.project_questionnaire_status TO authenticated;
GRANT EXECUTE ON FUNCTION public.questionnaire_fields() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.jsonb_is_answered(jsonb) TO authenticated, service_role;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Compare the computed percentage with the stored column. Expect wide disagreement: the stored
--    value reads 86 for nearly every project regardless of what is actually answered.
SELECT q.grant_number, q.status, q.fields_filled, q.fields_total, q.pct,
       p.metadata_completeness AS stored_pct, q.submitter_standing, q.owner_name
  FROM public.project_questionnaire_status q
  LEFT JOIN public.projects p ON p.id = q.project_id
 ORDER BY q.pct DESC, q.grant_number;

-- 2) The two responses imported on 2026-08-11 should be the only ones with a known submitter, and
--    both should read 'pi'.
SELECT grant_number, submitted_by, submitted_at::date, submitter_standing
  FROM public.project_questionnaire_status
 WHERE submitted_by IS NOT NULL
 ORDER BY grant_number;
