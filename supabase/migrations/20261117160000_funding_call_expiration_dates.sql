-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261117160000_funding_call_expiration_dates.sql
-- Fill the expiration date of the funding calls that have none, from each call's own notice.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHY. Seven of the 13 calls in the 2026-11-17 export have no expiration_date: the five PRIMED-AI
-- RFAs (RFA-RM-27-011 to -015), NSF 26-526 (GRFP) and the Simons Empire AI RFA. Two things follow:
--   * CQ39 ("Which funding opportunities expire between 2026-10-14 and 2027-04-14?") finds none.
--   * close-expired-funding-daily (07:15 UTC, 20260508185044) closes a call only once its
--     expiration_date has passed, so it can never close these: the Funding page still lists the
--     PRIMED-AI calls and the GRFP as open, although their deadlines passed in October 2026.
--
-- WHAT. One UPDATE, and only where expiration_date is still empty: a date already set is never
-- overwritten, and a second run changes nothing. The dates, as each call's notice gives them
-- (CHECK THEM against the notice before applying; the notices were read through a web search,
-- because this script was written where grants.nih.gov and simpler.grants.gov are not reachable):
--   RFA-RM-27-011  2026-10-10  Expiration Date (applications due 2026-10-09)
--   RFA-RM-27-012  2026-10-20  Expiration Date (applications due 2026-10-19)
--   RFA-RM-27-013  2026-10-20  Expiration Date (applications due 2026-10-19)
--   RFA-RM-27-014  2026-10-03  Expiration Date (applications due 2026-10-02)
--   NSF 26-526     2026-10-23  the last of the solicitation's deadlines by field (2026-10-19 to -23)
--   SIMONS-EMPIRE-AI-2026  2026-12-01  the application deadline, noon ET (the foundation calls this
--                  cycle, announced 2026-09-01, its "2027 Request for Applications")
--   RFA-RM-27-015 is left out: listings give its application due date (2026-10-02), but no
--   expiration date was found. Add it by hand from the notice: the Key Dates section's
--   "Expiration Date".
-- Sources: each row's own external_url (simpler.grants.gov/opportunity/..., nsf.gov/.../nsf26-526,
-- simonsfoundation.org/grant/utilizing-the-full-power-of-empire-ai-request-for-applications/).
--
-- EFFECT. CQ39 then returns RFA-RM-27-012, RFA-RM-27-013, NSF 26-526 and SIMONS-EMPIRE-AI-2026.
-- At the next 07:15 UTC run, close-expired-funding-daily marks the five calls whose date has passed
-- as closed (the script itself does not touch status); the Simons call stays open until 2026-12-01.
--
-- HOW TO APPLY: Supabase SQL editor, project vpexxhfpvghlejljwpvt. Paste the WHOLE file, Run. It is
-- one transaction; the last statement lists the seven calls with their date and whether this run
-- set it. Every change is audited under 'migration:funding_call_expiration_dates' (Principle X).
-- UNDO: data_audit_log keeps old_data for each UPDATE; set expiration_date back to NULL for those ids.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- Temp tables of an earlier run in this editor session go first, so the script can run again.
DROP TABLE IF EXISTS pg_temp.kg_call_dates, pg_temp.kg_call_dates_set;

BEGIN;
SELECT public.set_actor('migration:funding_call_expiration_dates');
SELECT public.set_source_class('curator_fill');

CREATE TEMP TABLE kg_call_dates (fon text PRIMARY KEY, expires date NOT NULL, basis text NOT NULL);
INSERT INTO kg_call_dates (fon, expires, basis) VALUES
  ('RFA-RM-27-011',         DATE '2026-10-10', 'the notice''s Expiration Date (applications due 2026-10-09)'),
  ('RFA-RM-27-012',         DATE '2026-10-20', 'the notice''s Expiration Date (applications due 2026-10-19)'),
  ('RFA-RM-27-013',         DATE '2026-10-20', 'the notice''s Expiration Date (applications due 2026-10-19)'),
  ('RFA-RM-27-014',         DATE '2026-10-03', 'the notice''s Expiration Date (applications due 2026-10-02)'),
  ('NSF 26-526',            DATE '2026-10-23', 'the last of the solicitation''s deadlines by field (2026-10-19 to 2026-10-23)'),
  ('SIMONS-EMPIRE-AI-2026', DATE '2026-12-01', 'the application deadline, 12 p.m. ET');

CREATE TEMP TABLE kg_call_dates_set (fon text PRIMARY KEY);
WITH done AS (
  UPDATE public.funding_opportunities AS f
     SET expiration_date = d.expires
    FROM kg_call_dates AS d
   WHERE f.fon = d.fon
     AND f.expiration_date IS NULL
  RETURNING f.fon
)
INSERT INTO kg_call_dates_set SELECT fon FROM done;

COMMIT;

-- The report (the editor shows only this last result).
SELECT d.fon,
       f.expiration_date,
       f.status,
       CASE WHEN f.id IS NULL THEN 'skipped: no call with this FON'
            WHEN s.fon IS NOT NULL THEN 'set by this run: ' || d.basis
            WHEN f.expiration_date = d.expires THEN 'already this date (nothing changed)'
            ELSE format('left as it was: the call already has %s (this script would have set %s)', f.expiration_date, d.expires)
       END AS outcome
  FROM kg_call_dates AS d
  LEFT JOIN public.funding_opportunities AS f ON f.fon = d.fon
  LEFT JOIN kg_call_dates_set AS s ON s.fon = d.fon
UNION ALL
SELECT f.fon, f.expiration_date, f.status, 'not in this script: add its Expiration Date by hand from the notice'
  FROM public.funding_opportunities AS f
 WHERE f.fon = 'RFA-RM-27-015'
 ORDER BY 2 NULLS LAST, 1;
