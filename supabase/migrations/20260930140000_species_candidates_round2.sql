-- Second pass over the species candidates (issue #429), each re-checked verbatim against its RePORTER
-- abstract. Two gaps the first pass left:
--
-- 1. Three candidates could never resolve. 'Drosophila melanogaster', 'Danio rerio' and 'Cichlidae'
--    match no species row, because Fruit Fly, Zebrafish and Cichlid Fish carry no scientific-name
--    alias; confirming them would have left KG invariant #7 firing. The aliases below close that.
--    Cichlidae is family level, which is what "Lake Malawi cichlids" (R34DA059510) supports: the
--    radiation is hundreds of species, and the Cichlid Fish row is itself family level.
-- 2. R34DA059512 studies predator AND prey -- "detailed measurements of both predator (mouse) and
--    prey (cricket)" -- but only the mouse was a candidate. R34DA059500 likewise images "freely moving
--    flies and fish": both, not a choice between them, so both are confirmed with _replace = false.
--
-- These are candidates and aliases only. A curator still confirms each one with the bbqs-mcp tool
-- confirm_species_candidate, which records it in their name with the quote.
SELECT public.set_actor('migration:species_candidates_round2');
SELECT public.set_source_class('curated_with_ai');

INSERT INTO public.species_aliases (alias, canonical, kind, common_name, note) VALUES
  ('drosophila melanogaster', 'Drosophila melanogaster', 'taxon', 'fruit fly', NULL),
  ('danio rerio',             'Danio rerio',             'taxon', 'zebrafish', NULL),
  ('cichlidae',               'Cichlidae',               'taxon', 'cichlid fish',
   'Family level: a project on a cichlid radiation (e.g. Lake Malawi) names the family, not one species.')
ON CONFLICT DO NOTHING;

INSERT INTO public.species_candidates
  (grant_number, candidate, common_name, evidence, confidence, note) VALUES
  ('R34DA059512', 'Cricket', 'cricket',
   'detailed measurements of both predator (mouse) and prey (cricket) spatiotemporal movement patterns',
   'strong', 'The prey species in the prey-capture paradigm; confirm with _replace = false next to Mus musculus. The cricket species is not named.')
ON CONFLICT DO NOTHING;

UPDATE public.species_candidates
   SET note = 'The project images freely moving flies AND fish: confirm both, the second with _replace = false.'
 WHERE grant_number = 'R34DA059500' AND candidate IN ('Drosophila melanogaster', 'Danio rerio');

-- Verify: the aliases resolve, and the cricket candidate is listed.
SELECT alias, canonical, common_name FROM public.species_aliases
 WHERE alias IN ('drosophila melanogaster', 'danio rerio', 'cichlidae');
SELECT grant_number, candidate, confidence FROM public.species_candidates
 WHERE grant_number IN ('R34DA059512', 'R34DA059500') ORDER BY 1, 2;
