-- Species candidates for the projects whose species field holds a category or a placeholder.
-- Constitution Principle XI.
--
-- THE QUESTION THAT PRODUCED THIS. Asked whether the nine projects listed as "something other than a
-- species" really have no species candidate, or whether the old YAML had simply invented values. I
-- checked all nine against their grant abstracts. The answer corrects something I had been saying
-- all week: for these projects the YAML was NOT hallucinating. It was BETTER than the KG.
--
--   grant         KG holds now                        YAML had              abstract says
--   R34DA062119   Developmental Models                Mus musculus          "developmental experience on mice"
--   R34DA059723   Freely moving animals               Mus musculus          "food-handling in mice"
--   R34DA061924   Interacting Animals                 ferret; rodents       "ferrets during naturalistic interaction"
--   R34DA059512   Rodents                             Rodentia              "natural mouse prey capture paradigm"
--   R34DA059510   Social species with male displays   Cichlidae             "Lake Malawi cichlids"
--   R34DA059500   Genetic Species                     Drosophila/Zebrafish  "freely moving flies and fish"
--   U01MH144347   (nothing)                           (no entry)            "human behavior ... Parkinsons, epilepsy"
--   U24MH136628   All Species                         All Species           infrastructure award
--   R24MH136632   All Species                         All Species           infrastructure award
--
-- Two of the nine genuinely have no species: the two infrastructure awards. The other seven have a
-- candidate sitting in their own grant abstract, and in six cases the YAML already had it.
--
-- WHY THIS DOES NOT JUST WRITE THEM. "mice" does not say WHICH mouse, and neither does "cichlids"
-- name a species — Lake Malawi cichlids are a radiation of hundreds. Writing Mus musculus over
-- "Developmental Models" would replace a useless value with a plausible one and lose the fact that
-- nobody has confirmed it. Principle XI's whole point is that a confident guess must not become
-- indistinguishable from a checked fact, so these are CANDIDATES with the quote that supports them,
-- and a curator confirms in one click. That records it at G4 in their name, which is the truth.
--
-- The guard would in fact PERMIT a machine write here, because the current values are G8 and the
-- gate only blocks unverified-over-verified. Permitted is not the same as right.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260822120000');
SELECT public.set_source_class('curator_fill');

CREATE TABLE IF NOT EXISTS public.species_candidates (
  grant_number text NOT NULL,
  candidate    text NOT NULL,
  common_name  text,
  evidence     text NOT NULL,
  source       text NOT NULL DEFAULT 'grant abstract (NIH RePORTER)',
  confidence   text NOT NULL CHECK (confidence IN ('strong', 'needs_choice')),
  note         text,
  PRIMARY KEY (grant_number, candidate)
);

COMMENT ON TABLE public.species_candidates IS
  'Species a grant abstract points to, for projects whose species field holds a category or placeholder. Candidates only: a curator confirms one, which records it at G4 in their name. confidence=needs_choice means the abstract names a group rather than a species, so a human must pick.';

INSERT INTO public.species_candidates
  (grant_number, candidate, common_name, evidence, confidence, note) VALUES
  ('R34DA062119', 'Mus musculus', 'house mouse',
   'to the study of the effects of developmental experience on mice whose genetics, rearing and testing conditions can be carefully controlled',
   'strong', 'Laboratory mouse; the abstract says mice throughout.'),
  ('R34DA059723', 'Mus musculus', 'house mouse',
   'developing paradigms for analyzing food-handling in mice using high-speed close-up video methods',
   'strong', 'Laboratory mouse.'),
  ('R34DA061924', 'Mustela putorius furo', 'domestic ferret',
   'simultaneously recorded behavioral and electrophysiology data from ferrets during naturalistic interaction. Ferrets are chosen as a model',
   'strong', 'The accepted name is the subspecies. The abstract also mentions humans in framing only.'),
  ('R34DA059512', 'Mus musculus', 'house mouse',
   'of behavioral and eliciting stimulus dynamics in a natural mouse prey capture paradigm',
   'strong', 'More specific than the old YAML, which said only Rodentia.'),
  ('R34DA059510', 'Cichlidae', 'Lake Malawi cichlids',
   'This work will utilize Lake Malawi cichlids, a powerful evolutionary model for identification of genes',
   'needs_choice', 'A FAMILY, not a species: the Lake Malawi radiation is hundreds of species. The project must say which.'),
  ('R34DA059500', 'Drosophila melanogaster', 'fruit fly',
   'and techniques for imaging neural activity in freely moving flies and fish',
   'needs_choice', 'Two organisms in one project, and neither is named to species. Likely D. melanogaster and Danio rerio; confirm both.'),
  ('R34DA059500', 'Danio rerio', 'zebrafish',
   'and techniques for imaging neural activity in freely moving flies and fish',
   'needs_choice', 'See the note on the fly candidate for this grant.'),
  ('U01MH144347', 'Homo sapiens', 'human',
   'next-generation clinical studies of the brain mechanisms of human behavior such as in Parkinsons, epilepsy, depression',
   'strong', 'A DBS trial collecting patient-reported outcomes. Humans is as safe as an inference gets, but it is still an inference.')
ON CONFLICT (grant_number, candidate) DO UPDATE
  SET common_name = excluded.common_name, evidence = excluded.evidence,
      confidence = excluded.confidence, note = excluded.note;

ALTER TABLE public.species_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anyone may read species candidates" ON public.species_candidates;
CREATE POLICY "anyone may read species candidates" ON public.species_candidates
  FOR SELECT USING (true);
GRANT SELECT ON public.species_candidates TO anon, authenticated;

/** Confirm a candidate: set the species AND record who stands behind it, in one transaction.
 *  Deliberately not two steps — a value written without its provenance is the thing this whole
 *  feature exists to stop, and a caller that has to remember the second call will forget. */
CREATE OR REPLACE FUNCTION public.confirm_species_candidate(
  _grant_number text, _candidate text, _replace boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _pid  uuid;
  _who  text;
  _cand record;
  _new  text[];
BEGIN
  IF auth.uid() IS NULL
     OR NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can confirm a species';
  END IF;

  SELECT * INTO _cand FROM public.species_candidates
   WHERE grant_number = _grant_number AND candidate = _candidate;
  IF _cand IS NULL THEN
    RAISE EXCEPTION 'No such candidate: % for %', _candidate, _grant_number;
  END IF;

  SELECT id INTO _pid FROM public.projects WHERE grant_number = _grant_number;
  IF _pid IS NULL THEN
    RAISE EXCEPTION 'No project for grant %', _grant_number;
  END IF;

  SELECT coalesce(u.email, auth.uid()::text) INTO _who FROM auth.users u WHERE u.id = auth.uid();

  -- _replace false ADDS the species, for a project that genuinely studies more than one.
  SELECT CASE WHEN _replace THEN ARRAY[_candidate]
              ELSE array_agg(DISTINCT s) END
    INTO _new
    FROM unnest(
      CASE WHEN _replace THEN ARRAY[_candidate]
           ELSE coalesce((SELECT study_species FROM public.projects WHERE id = _pid), '{}') || _candidate
      END) AS s;

  -- The guard on projects records the provenance for this write automatically, at the class this
  -- session resolves to -- curator_fill, since a signed-in human is doing it.
  UPDATE public.projects SET study_species = _new WHERE id = _pid;

  -- Then say WHY, with the quote, which the automatic record cannot know.
  PERFORM public.record_field_provenance(
    'projects', _pid, 'study_species', 'curator_fill', 'confirmed_species_candidate',
    _who, _cand.source, array_to_string(_new, ', '),
    format('Confirmed by %s from the grant abstract: "%s"', _who, _cand.evidence));

  RETURN jsonb_build_object('ok', true, 'grant_number', _grant_number,
                            'study_species', _new, 'confirmed_by', _who);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.confirm_species_candidate(text, text, boolean) TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) The candidates, next to what the project currently claims.
SELECT c.grant_number,
       array_to_string(p.study_species, ', ') AS currently,
       c.candidate, c.confidence, left(c.evidence, 60) AS evidence
  FROM public.species_candidates c
  LEFT JOIN public.projects p ON p.grant_number = c.grant_number
 ORDER BY c.confidence, c.grant_number;

-- 2) Which of the nine still have no candidate. Expect exactly the two infrastructure awards.
SELECT ps.grant_number, ps.recorded_value, ps.kind
  FROM public.project_species ps
  LEFT JOIN public.species_candidates c ON c.grant_number = ps.grant_number
 WHERE ps.kind NOT IN ('taxon', 'taxon_assumed') AND c.grant_number IS NULL
 ORDER BY ps.grant_number;
