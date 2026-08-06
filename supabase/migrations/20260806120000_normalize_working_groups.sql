-- Canonicalize investigators.working_groups at the DATABASE floor, so NO write path
-- (agent, admin console, member profile pane, Google-Form import, or a raw SQL edit)
-- can ever store a non-canonical token. Bug 2026-08-06: a member was saved with the BARE
-- token 'Analytics' instead of 'WG-Analytics' → it appeared as a phantom 5th working group
-- in `select distinct unnest(working_groups)` AND dropped the member out of the real
-- WG-Analytics roster + its Google-Group sync. The agent's write schema was hardened
-- (bbqs-agent), but the token actually entered via a non-agent path (provenance:
-- data_audit_log actor = an admin JWT). This trigger is the belt-and-suspenders that
-- catches every path.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor
-- (project vpexxhfpvghlejljwpvt).

-- ── 1. Canonicalizer — mirrors bbqs-agent's canonicalWorkingGroup() ─────────────
-- Maps any case / prefix / separator form of the four real working groups to the stored
-- 'WG-*' token; leaves an UNrecognized value untouched (never silently drops an admin
-- value it doesn't know — those are visible and can be handled deliberately).
CREATE OR REPLACE FUNCTION public.canonical_working_group(_wg text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE regexp_replace(lower(trim(_wg)), '^wg[-_ ]?', '')
    WHEN 'analytics' THEN 'WG-Analytics'
    WHEN 'devices'   THEN 'WG-Devices'
    WHEN 'elsi'      THEN 'WG-ELSI'
    WHEN 'standards' THEN 'WG-Standards'
    ELSE _wg
  END
$$;

-- ── 2. BEFORE trigger — canonicalize + dedupe on the way in ─────────────────────
CREATE OR REPLACE FUNCTION public.normalize_working_groups()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.working_groups IS NOT NULL AND array_length(NEW.working_groups, 1) > 0 THEN
    NEW.working_groups := (
      SELECT coalesce(array_agg(DISTINCT public.canonical_working_group(trim(wg))), NEW.working_groups)
      FROM unnest(NEW.working_groups) AS wg
      WHERE wg IS NOT NULL AND length(trim(wg)) > 0
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_working_groups ON public.investigators;
CREATE TRIGGER trg_normalize_working_groups
  BEFORE INSERT OR UPDATE OF working_groups ON public.investigators
  FOR EACH ROW EXECUTE FUNCTION public.normalize_working_groups();

-- ── 3. One-time backfill — clean any existing non-canonical tokens ──────────────
-- Only touches rows that actually hold a token differing from its canonical form
-- (idempotent; re-running changes nothing). This UPDATE fires the trigger above and the
-- data_audit_log trigger, so the correction is itself provenance-logged.
UPDATE public.investigators i
SET working_groups = (
      SELECT array_agg(DISTINCT public.canonical_working_group(trim(wg)))
      FROM unnest(i.working_groups) AS wg
      WHERE wg IS NOT NULL AND length(trim(wg)) > 0
    )
WHERE i.working_groups IS NOT NULL
  AND array_length(i.working_groups, 1) > 0
  AND EXISTS (
    SELECT 1 FROM unnest(i.working_groups) AS wg
    WHERE public.canonical_working_group(trim(wg)) IS DISTINCT FROM wg
  );
