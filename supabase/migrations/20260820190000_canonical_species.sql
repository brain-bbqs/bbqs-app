-- One canonical name per species, and an honest label for the values that are not species at all.
-- Constitution Principle XI (the species vocabulary goal in specs/012-field-provenance).
--
-- THE PROBLEM, as it renders today on /species. 23 distinct study_species values across 31 projects:
--
--   ELEVEN PROJECTS, FIVE SPELLINGS OF ONE SPECIES
--     Humans (7), Human, Homo sapiens, Humans (Epilepsy Patients), Humans (Pediatric)
--   SAME ANIMAL, TWO NAMES
--     Mouse (3) / Mus musculus;  Gerbil / Meriones unguiculatus
--   NOT SPECIES AT ALL, listed as species (7 projects)
--     All Species (2), Genetic Species, Developmental Models, Freely moving animals,
--     Interacting Animals, Social species with male displays
--   EMPTY, rendered as a species called "Unknown"
--     U01MH144347 (SMART-DBS), which has no species in any source yet
--
-- The page was not wrong; it started telling the truth. Until this week /species read
-- target_species_domain out of a checked-in YAML, where someone had hand-written tidy strings, so
-- the underlying vocabulary was invisible. Pointing the page at the KG made the real state visible
-- and ugly at the same time, which is the honest order of events but not a finished job.
--
-- WHY A TABLE, not a CASE in the page. The agent reads species too (kgFetch, the Explorer persona,
-- the embeddings pipeline), and a mapping that lives in one React component is a mapping the agent
-- disagrees with. Same argument as source_classes: the vocabulary is data.
--
-- WHY THIS DOES NOT REWRITE study_species. Mapping "Marmosets" to Callithrix jacchus is an
-- inference, and Principle XI forbids writing an inference over a recorded value silently. So the
-- raw value stays, the canonical name is derived for display, and kind='taxon_assumed' marks the
-- ones that are a judgement rather than a reading. The real fix is the questionnaire: the project's
-- own people can say which species, and that lands at G2 with a named respondent.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260820190000');
SELECT public.set_source_class('curator_fill');

CREATE TABLE IF NOT EXISTS public.species_aliases (
  alias        text PRIMARY KEY,
  canonical    text,
  kind         text NOT NULL CHECK (kind IN ('taxon', 'taxon_assumed', 'category', 'placeholder')),
  common_name  text,
  note         text
);

COMMENT ON TABLE public.species_aliases IS
  'Maps the species names actually recorded in projects.study_species onto one canonical name each, and marks the values that are not species. Data rather than code because the agent reads species as well as the site, and a mapping inside one React component is a mapping the agent disagrees with.';
COMMENT ON COLUMN public.species_aliases.kind IS
  'taxon = the canonical name is read straight from the alias. taxon_assumed = a judgement, e.g. "Marmosets" -> Callithrix jacchus; the UI marks these. category = a grouping, not a species ("Rodents"). placeholder = says nothing ("All Species", "New Model System").';

INSERT INTO public.species_aliases (alias, canonical, kind, common_name, note) VALUES
  -- Eleven projects, five spellings.
  ('humans',                      'Homo sapiens', 'taxon', 'human', NULL),
  ('human',                       'Homo sapiens', 'taxon', 'human', NULL),
  ('homo sapiens',                'Homo sapiens', 'taxon', 'human', NULL),
  ('humans (epilepsy patients)',  'Homo sapiens', 'taxon', 'human', 'Cohort detail, not a separate species: epilepsy patients.'),
  ('humans (pediatric)',          'Homo sapiens', 'taxon', 'human', 'Cohort detail, not a separate species: paediatric.'),
  -- Same animal, two names.
  ('mouse',                       'Mus musculus', 'taxon', 'house mouse', NULL),
  ('mice',                        'Mus musculus', 'taxon', 'house mouse', NULL),
  ('mus musculus',                'Mus musculus', 'taxon', 'house mouse', NULL),
  ('gerbil',                      'Meriones unguiculatus', 'taxon', 'Mongolian gerbil', NULL),
  ('meriones unguiculatus',       'Meriones unguiculatus', 'taxon', 'Mongolian gerbil', NULL),
  ('rat',                         'Rattus norvegicus', 'taxon', 'Norway rat', NULL),
  ('rattus norvegicus',           'Rattus norvegicus', 'taxon', 'Norway rat', NULL),
  -- Already canonical.
  ('cebus imitator',              'Cebus imitator', 'taxon', 'white-faced capuchin', NULL),
  ('molothrus ater',              'Molothrus ater', 'taxon', 'brown-headed cowbird', NULL),
  ('hofstenia miamia',            'Hofstenia miamia', 'taxon', 'panther worm', NULL),
  ('ovis aries',                  'Ovis aries', 'taxon', 'domestic sheep', NULL),
  ('taeniopygia guttata',         'Taeniopygia guttata', 'taxon', 'zebra finch', NULL),
  -- A judgement, marked as one.
  ('marmosets',                   'Callithrix jacchus', 'taxon_assumed', 'common marmoset',
   'The common marmoset is the usual laboratory marmoset, but the record does not say which. Confirm with the project.'),
  ('marmoset',                    'Callithrix jacchus', 'taxon_assumed', 'common marmoset',
   'The common marmoset is the usual laboratory marmoset, but the record does not say which. Confirm with the project.'),
  ('ferret',                      'Mustela putorius furo', 'taxon_assumed', 'domestic ferret',
   'Domestic ferret assumed; the accepted name is the subspecies.'),
  ('ferrets',                     'Mustela putorius furo', 'taxon_assumed', 'domestic ferret',
   'Domestic ferret assumed; the accepted name is the subspecies.'),
  -- Groupings. Real information, but not a species, so not listed as one.
  ('rodents',                     NULL, 'category', NULL, 'A group, not a species.'),
  ('rodentia',                    NULL, 'category', NULL, 'A group, not a species.'),
  ('freely moving animals',       NULL, 'category', NULL, 'Describes the recording condition, not the animal.'),
  ('interacting animals',         NULL, 'category', NULL, 'Describes the paradigm, not the animal.'),
  ('social species with male displays', NULL, 'category', NULL, 'Describes the behaviour of interest, not the animal.'),
  ('developmental models',        NULL, 'category', NULL, 'Describes the model class, not the animal.'),
  ('wild primates',               NULL, 'category', NULL, 'A group, not a species.'),
  -- Says nothing at all.
  ('all species',                 NULL, 'placeholder', NULL, 'Infrastructure award: not species-specific.'),
  ('genetic species',             NULL, 'placeholder', NULL, 'Not a species name.'),
  ('new model system',            NULL, 'placeholder', NULL, 'Not a species name.'),
  ('requires verification',       NULL, 'placeholder', NULL, 'A note to self that was left in a data field.')
ON CONFLICT (alias) DO UPDATE
  SET canonical = excluded.canonical, kind = excluded.kind,
      common_name = excluded.common_name, note = excluded.note;

ALTER TABLE public.species_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anyone may read the species vocabulary" ON public.species_aliases;
CREATE POLICY "anyone may read the species vocabulary" ON public.species_aliases
  FOR SELECT USING (true);
GRANT SELECT ON public.species_aliases TO anon, authenticated;

/** One row per (project, recorded species value), with its canonical name and what kind of thing
 *  the value actually is. A project with no species at all still appears, with kind 'none', because
 *  a missing species is a fact about the project and hiding it is how "Unknown" became a species. */
CREATE OR REPLACE VIEW public.project_species
WITH (security_invoker = true)
AS
SELECT p.id                                  AS project_id,
       p.grant_number,
       raw.value                             AS recorded_value,
       coalesce(a.canonical, raw.value)      AS canonical_name,
       coalesce(a.kind,
                -- Unmapped but shaped like a binomial: treat as a taxon rather than lose it.
                CASE WHEN raw.value ~ '^[A-Z][a-z]+ [a-z]+( [a-z]+)?$' THEN 'taxon' END,
                CASE WHEN raw.value IS NULL THEN 'none' ELSE 'unmapped' END) AS kind,
       a.common_name,
       a.note
  FROM public.projects p
  LEFT JOIN LATERAL unnest(
         CASE WHEN coalesce(array_length(p.study_species, 1), 0) = 0
              THEN ARRAY[NULL]::text[] ELSE p.study_species END) AS raw(value) ON true
  LEFT JOIN public.species_aliases a ON a.alias = lower(btrim(raw.value));

COMMENT ON VIEW public.project_species IS
  'Species per project, canonicalised. kind tells you what you are looking at: taxon, taxon_assumed (a judgement), category or placeholder (not a species), unmapped (not in species_aliases yet), none (the project records no species). Group by canonical_name WHERE kind LIKE ''taxon%'' for a real species list.';

GRANT SELECT ON public.project_species TO anon, authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) What /species should now show: real species, deduplicated. Homo sapiens should collapse five
--    spellings into one row covering eleven projects.
SELECT canonical_name, common_name, count(DISTINCT project_id) AS projects
  FROM public.project_species
 WHERE kind IN ('taxon', 'taxon_assumed')
 GROUP BY canonical_name, common_name
 ORDER BY projects DESC, canonical_name;

-- 2) Everything that is NOT a species, and so must stop being listed as one.
SELECT kind, recorded_value, grant_number
  FROM public.project_species
 WHERE kind NOT IN ('taxon', 'taxon_assumed')
 ORDER BY kind, recorded_value;

-- 3) Nothing should be 'unmapped'. Anything here needs a row in species_aliases.
SELECT DISTINCT recorded_value FROM public.project_species WHERE kind = 'unmapped';

-- 4) The five spellings of one species really did collapse.
SELECT count(*) AS homo_sapiens_rows, count(DISTINCT recorded_value) AS spellings_merged
  FROM public.project_species WHERE canonical_name = 'Homo sapiens';
