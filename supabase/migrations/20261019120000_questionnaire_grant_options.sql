-- questionnaire_grant_options(): the project list the data-questionnaire Google Forms offer.
--
-- The Forms "Grants (select all you are working on …)" checkbox is kept in sync by an Apps Script
-- (scripts/forms/sync-project-dropdowns.gs). It used to read a hand-exported Google Sheet; it now
-- reads this function directly over PostgREST with the anon key, so a new award becomes selectable
-- on the next run with no manual export (Principle III: the forms follow live KG state).
--
-- SECURITY DEFINER on purpose: the label needs the PI names, and investigators is NOT anon-readable
-- (RLS protects it). PI names per grant are already public — the consortium Projects page and NIH
-- RePORTER both show them — so aggregating them here is a deliberate, MINIMAL public projection:
-- grant_number, activity_code, title, pis. No emails, institutions, ids, or any other column leaves
-- the function. It is read-only (STABLE) and takes no arguments.
--
-- Apply MANUALLY in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20261019_questionnaire_grant_options');

CREATE OR REPLACE FUNCTION public.questionnaire_grant_options()
RETURNS TABLE (grant_number text, activity_code text, title text, pis text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    g.grant_number,
    -- Activity code the Forms label uses: grant number with any leading application-type digit
    -- stripped, first three chars — 'U01MH143789' -> 'U01', '1R61MH135106' -> 'R61'.
    substr(regexp_replace(g.grant_number, '^[0-9]+', ''), 1, 3) AS activity_code,
    g.title,
    (
      -- Full PI names as stored, to match the forms' existing "(PI(s): …)" style (e.g.
      -- "NANTHIA W SUTHANA*"). Contact/lead PI first and marked with '*' (legend: "*Lead/Contact
      -- PI"). This normalizes the mark onto the REAL contact PI — the old hand-export only ever put
      -- a single '*' on the last-listed name, which was not always the contact.
      SELECT string_agg(
               i.name || CASE WHEN lower(gi.role) = 'contact_pi' THEN '*' ELSE '' END,
               ', ' ORDER BY (lower(gi.role) = 'contact_pi') DESC, i.name)
      FROM public.grant_investigators gi
      JOIN public.investigators i ON i.id = gi.investigator_id
      WHERE gi.grant_id = g.id
        AND lower(gi.role) IN ('contact_pi', 'co_pi', 'mpi', 'pi')
    ) AS pis
  FROM public.grants g
  WHERE coalesce(btrim(g.title), '') <> ''
  ORDER BY g.grant_number
$$;

COMMENT ON FUNCTION public.questionnaire_grant_options() IS
  'Public, read-only project list for the data-questionnaire Google Forms updater (scripts/forms/sync-project-dropdowns.gs). SECURITY DEFINER so PI surnames (already public) can be aggregated past investigators RLS; exposes only grant_number, activity_code, title, pis.';

GRANT EXECUTE ON FUNCTION public.questionnaire_grant_options() TO anon, authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────────────────────────
-- Expect the U01 with activity_code U01 and pis 'NANTHIA W SUTHANA*'.
SELECT * FROM public.questionnaire_grant_options() WHERE grant_number = 'U01MH143789';
-- Spot-check the shape across a few rows.
SELECT grant_number, activity_code, pis FROM public.questionnaire_grant_options() LIMIT 10;
