-- Correct study_species from the grant's own abstract (feature 012 P5).
--
-- WHY. The /projects species audit (2026-08-19) found the KG holding species that the grant
-- abstract contradicts. Two were confident Latin species names naming the wrong animal, and one was a
-- placeholder standing where a species belongs. Nothing on screen marked any of them as generated,
-- so they read as curated fact:
--
--   R34DA059507  Taeniopygia guttata (zebra finch)   -> Molothrus ater   (brown-headed cowbird)
--   R34DA061925  Cebus capucinus (wrong species after the genus split)
--                                                    -> Cebus imitator
--   R34DA061984  "New Model System" (a placeholder)  -> Hofstenia miamia (acoel/panther worm)
--
-- TIER. Constitution v1.8.0 Principle XI ranks NIH RePORTER above every derived source, so these
-- writes are a HIGHER tier landing on a lower one, which the principle permits. Each carries the
-- exact sentence from the abstract, so a human verifies the claim in one glance instead of trusting
-- an extractor. Of all 31 grants only these three spell out the Latin species name; the other 28 give
-- common names or categories only, and re-deriving those would be tier-5 INFERENCE, which
-- Principle XI forbids writing silently. Those stay proposals -- see specs/012-field-provenance.
--
-- PROVENANCE. metadata.field_provenance.<column> records the tier, activity, agent and evidence.
-- This is deliberately shaped like the field_provenance TABLE that P1 introduces, so P1 migrates
-- these stanzas out of JSONB rather than reconciling two vocabularies. set_actor() additionally
-- attributes the row-level change in data_audit_log (verified live: projects IS audited).
--
-- SAFETY. Each update is guarded on the value observed during the audit. If someone corrected a
-- row in the meantime the guard simply does not match, the row is left alone, and the verify block
-- at the bottom reports it rather than this migration clobbering a better value.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260819120000');

UPDATE public.projects p
   SET study_species = ARRAY[c.taxon]::text[],
       metadata = coalesce(p.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'field_provenance',
                       coalesce(p.metadata -> 'field_provenance', '{}'::jsonb)
                       || jsonb_build_object('study_species', jsonb_build_object(
                            'source_class',       1,
                            'source_class_label', 'authoritative_registry',
                            'activity',           'reporter_abstract_quote',
                            'agent_kind',         'external_registry',
                            'agent_label',        'NIH RePORTER',
                            'source_ref',         c.project_num,
                            'evidence',           c.quote,
                            'replaced_value',     c.was,
                            'recorded_by',        'migration:20260819120000',
                            'recorded_at',        now()
                          )))
  FROM (VALUES
          ($q$R34DA059507$q$, $q$Molothrus ater$q$, $q$R34DA059507$q$, $q$Here we propose to study the brown-headed cowbird (Molothrus ater), a highly gregarious songbird species whose social behavior has been well studied and where vocal and non-vocal communication signals form a central and critical component of its social system.$q$, $q$Taeniopygia guttata$q$),
          ($q$R34DA061925$q$, $q$Cebus imitator$q$, $q$R34DA061925$q$, $q$Laboratory-based paradigms will be brought to a wild population of ~350 white-faced capuchin monkeys (Cebus imitator) living in a small, tractable forest in Costa Rica (Taboga Forest Reserve).$q$, $q$Cebus capucinus$q$),
          ($q$R34DA061984$q$, $q$Hofstenia miamia$q$, $q$R34DA061984$q$, $q$We will study the acoel worm, Hofstenia miamia, which is a new research organism with key features that position it to address major questions in behavioral neuroscience.$q$, $q$New Model System$q$)
       ) AS c(grant_number, taxon, project_num, quote, was)
 WHERE p.grant_number = c.grant_number
   -- Optimistic guard: only rewrite the value the audit actually saw.
   AND array_to_string(coalesce(p.study_species, '{}'::text[]), ', ') = c.was;

-- Verify -----------------------------------------------------------------------------------------
-- 1) All three corrected, each carrying tier-1 provenance and its evidence sentence.
SELECT p.grant_number,
       array_to_string(p.study_species, ', ')                                       AS species_now,
       p.metadata -> 'field_provenance' -> 'study_species' ->> 'source_class'        AS tier,
       p.metadata -> 'field_provenance' -> 'study_species' ->> 'replaced_value'      AS was,
       left(p.metadata -> 'field_provenance' -> 'study_species' ->> 'evidence', 80)  AS evidence
  FROM public.projects p
 WHERE p.grant_number IN ('R34DA059507', 'R34DA061925', 'R34DA061984')
 ORDER BY p.grant_number;

-- 2) Expect 3. Fewer means an optimistic guard did not match -- inspect before re-running.
SELECT count(*) AS corrected_must_be_3
  FROM public.projects
 WHERE metadata -> 'field_provenance' -> 'study_species' ->> 'recorded_by'
       = 'migration:20260819120000';

-- 3) The row-level audit trail picked it up and attributed it.
SELECT table_name, actor_label, operation, occurred_at
  FROM public.data_audit_log
 WHERE actor_label = 'migration:20260819120000'
 ORDER BY occurred_at DESC;
