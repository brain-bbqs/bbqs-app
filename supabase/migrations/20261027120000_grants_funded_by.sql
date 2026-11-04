-- grants.funded_by: the NIH institute that funds each award (NIMH, NIDA, ...).
--
-- WHY. The knowledge graph carries a funder fact per Project, and the database had nowhere to keep it,
-- so the graph could not map back to the database for it (#442, #475). The value is not new
-- information: the two letters after the activity code in grant_number name the institute
-- (R34DA059506 -> DA -> NIDA; R61MH135106 -> MH -> NIMH). This migration stores that, so the graph
-- and the database say it once each, and a curator can correct it where RePORTER says otherwise.
--
-- DECISION. A plain text column holding the institute acronym, on `grants` (the award facet of a
-- Project). Not a foreign key and not a new spine row: FundingAgency nodes are not in the resources
-- spine yet, and minting nodes outside it breaks "one row = one IRI". The graph exports it as a
-- fact (bbqs:funded_by); the existing `funder` link slot stays reserved for when agencies become
-- spine rows.
--
-- IDEMPOTENT. Adds the column only if missing and fills only rows where it is NULL, so a value a
-- curator set is never overwritten. An IC code not in the map below stays NULL and is listed by the
-- check at the end, not guessed.
--
-- Apply by hand in the Supabase SQL editor for vpexxhfpvghlejljwpvt (migrations are not db-pushed).

-- Principle X: name the writer before the first write, or the audit rows record what changed and
-- not who changed it.
SELECT public.set_actor('migration:20261027120000_grants_funded_by');

ALTER TABLE public.grants ADD COLUMN IF NOT EXISTS funded_by text;

COMMENT ON COLUMN public.grants.funded_by IS
  'NIH institute funding the award (NIMH, NIDA, ...). Backfilled from the institute letters of grant_number; exported to the knowledge graph as bbqs:funded_by.';

-- Institute letters -> acronym. Keep this map equal to the one in
-- kg/shapes/consistency.shapes.ttl (FunderMatchesGrantNumberShape); tests/guards/kg-shape-catalog-parity
-- fails if they differ.
UPDATE public.grants g
   SET funded_by = m.acronym
  FROM (VALUES
    ('MH', 'NIMH'), ('DA', 'NIDA'), ('NS', 'NINDS'), ('EB', 'NIBIB'), ('AA', 'NIAAA'),
    ('AG', 'NIA'),  ('EY', 'NEI'),  ('DC', 'NIDCD'), ('HD', 'NICHD'), ('HG', 'NHGRI'),
    ('GM', 'NIGMS'), ('NR', 'NINR'), ('TR', 'NCATS'), ('OD', 'NIH-OD')
  ) AS m(ic, acronym)
 WHERE g.funded_by IS NULL
   AND substring(g.grant_number FROM '^[A-Z][A-Z0-9]{2}([A-Z]{2})') = m.ic;

-- ── Checks (read-only; run after the update) ─────────────────────────────────────────────
-- 1) How the awards split by funder. Expect no NULL row unless an institute is missing from the map.
SELECT funded_by, count(*) AS grants FROM public.grants GROUP BY funded_by ORDER BY grants DESC;

-- 2) Awards left without a funder, with the institute letters that were not recognised: expect ZERO
--    rows. Any row here needs its letters added to the map (and to the shape), not a guess.
SELECT grant_number,
       substring(grant_number FROM '^[A-Z][A-Z0-9]{2}([A-Z]{2})') AS institute_letters
  FROM public.grants
 WHERE funded_by IS NULL;
