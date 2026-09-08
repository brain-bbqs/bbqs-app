-- Make funding_opportunities.fon unique, so add_funding_opportunity can UPSERT on it — re-adding a
-- FON then refreshes the row instead of duplicating or stranding a bare one (which is how NSF 26-526
-- ended up with only fon+title after the array-param bug). FON is already de-facto unique: 15/15
-- distinct, checked 2026-09-03.
--
-- Also removes the TEST-DIAG-* rows a debugging session left live on the public Funding page.
--
-- Apply MANUALLY in the KG SQL editor.

SELECT public.set_actor('migration:20260903140000_funding_fon_unique');

DELETE FROM public.funding_opportunities WHERE fon LIKE 'TEST-DIAG-%';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'funding_opportunities_fon_key') THEN
    ALTER TABLE public.funding_opportunities ADD CONSTRAINT funding_opportunities_fon_key UNIQUE (fon);
  END IF;
END $$;

SELECT count(*) AS remaining_test_rows FROM public.funding_opportunities WHERE fon LIKE 'TEST-DIAG-%';
