# BBQS Knowledge Graph — Consistency Report

**Date:** 2026-09-21 (counts refreshed 2026-09-23) · **Status:** in progress · **Tracking:** [brain-bbqs/bbqs-app#386](https://github.com/brain-bbqs/bbqs-app/issues/386)

## Executive summary

We can **generate** a BBQS knowledge graph from the live database and **validate** that no part
contradicts another. After the Phase-5 backfill (every entity is now in the `resources` spine) and
the spine-first exporter, the anon run produces a **3,044-triple graph, one node per entity**, and it
validates to **6 unresolved `study_species`** (invariant #7) — all genuine curation items. Folding
`species_aliases` (synonyms/scientific names) and routing "no species by design" values (infrastructure
awards' `All Species`) to `study_scope` cut the original 26 dangling values to those 6. The
role-vocabulary (#4) and grant-mechanism (#9) checks conform.

The goal of this effort is **consistency, not completeness**: we validate that parts of the graph do
not contradict each other. Missing detail (a project with no devices) is *out of scope* — a gap, not
a contradiction.

## Approach

| Concern | Decision |
|---|---|
| Schema logic | OWL, authored in LinkML (`kg/bbqs.linkml.yaml`) → `gen-owl` / `gen-shacl` |
| Validation | SHACL first (pyshacl); OWL reasoner (robot/HermiT) later |
| Node spine | Supabase `resources` table — one row = one IRI, `resource_type` = rdf:type |
| Instances | `kg/bbqs_kg.py` (`BBQSKnowledgeGraph.export`) walks the spine → instance TTL |
| Consistency checks | three layers: Node guards (schema↔DB drift), SHACL shapes (structural + contradiction), OWL reasoning (deferred) |

The full 19-row invariant catalogue and how to run everything are in [README.md](README.md).

## Latest run — 2026-09-23 (anon, spine-first)

**3,044 triples**, one node per entity. Node counts: Investigator 263, ProjectRole 111,
Publication 45, ResearchOrganization 37, Device 35, DeviceCategory 34, DeviceManufacturer 32,
Project 34, Dataset 24, SoftwareTool 19, FundingOpportunity 14, Species 15, Announcement 12,
Job 6, Benchmark 3, MLModel 3, Protocol 1, Event 1, WorkingGroup 4.

Validated against the consistency shapes: **`Conforms: False`, 6 violations — all invariant #7**.
#4 and #9 conform; `held_by` is omitted under anon (its referential shape passes); #5/#12/#14–#19
have no anon targets (PII / `field_provenance` are RLS-hidden, and #19 is guarded to stay dormant
while the provenance layer is absent).

## Findings

### F1 — `study_species` values that do not resolve to a Species node (invariant #7)

`projects.study_species[]` is free text; the `species` table holds canonical common-name entries. The
exporter folds `species_aliases` (synonyms/scientific names) and routes "no species by design" markers
to `study_scope`. That leaves **6** genuine cases — all needing people, not code:

| Grant | `study_species` value | Status | Needs |
|---|---|---|---|
| R34DA061984 | `Hofstenia miamia` | **fixed** — panther-worm `species` row added (`migration:add_hofstenia_species`) | nothing (resolves) |
| R34DA059723 | `Freely moving animals` | candidate *Mus musculus* (strong) | curator confirm |
| R34DA062119 | `Developmental Models` | candidate *Mus musculus* (strong) | curator confirm |
| R34DA059512 | `Rodents` | candidate *Mus musculus* (strong) | curator confirm |
| R34DA061924 | `Interacting Animals` | candidate *Mustela putorius furo* (strong) | curator confirm |
| R34DA059500 | `Genetic Species` | flies **and** fish, neither named (`needs_choice`) | project team |
| R34DA059510 | `Social species with male displays` | Lake Malawi cichlids — hundreds (`needs_choice`) | project team |
| R24MH136632 (EMBER) | `All Species` | infrastructure award — no species by design | nothing (→ `study_scope`, not flagged) |
| U24DA064429 (BARD.CC) | `All Species` | infrastructure award (renumbered from U24MH136628, #385) | nothing (→ `study_scope`, not flagged) |

Candidates live in `species_candidates` (see the migration) and a curator confirms one with
`confirm_species_candidate`, recording it in their name. Trajectory: **6 → 2** (after the four strong
confirmations) **→ 0** (once the two project teams choose). The two `All Species` are already off the
#7 list via `study_scope`.

### F2 — role vocabulary was mis-modelled; one real normalization gap

The schema's `project_role_enum` was wrong (invented hyphenated tokens). The live
`grant_investigators.role` vocabulary is `contact_pi, co_pi, mpi, trainee, postdoc, graduate_student,
research_staff` — **underscore-separated** — plus the single **hyphenated** `co-investigator`, a
genuine normalization inconsistency worth a data fix. (`role_source` ∈ `reporter, curator, funder_notice`.)

### F3 — node-spine gaps (resolved by the Phase-5 backfill)

The original run found species/devices/orgs/pubs living only in their own tables. The #386 backfill
brought all of them into the `resources` spine (with `resource_id`), and the exporter now spine-sources
every entity — so the earlier org/pub double-node and the `project` double-node are gone. **Remaining:**
a few orphan `resources` rows the backfill left (~14 `investigator` + 1 `grant` pointing at no table
row) still need cleanup, and an insert trigger should auto-link new rows.

### F4 — coverage limits of this run

The exporter ran as **anon**, so RLS hid the `investigators` detail table, `field_provenance`,
`source_classes`, and working-group detail. Invariants **#5, #12, #14, #15, #17, #18, #19** therefore
had no data to check; a full-access export (Phase 6) exercises them.

### F5 — OWL reasoning (HermiT via owlready2): exporter datatype drift + one bad URL

The first reasoner pass found the anon export **inconsistent**. Cause: the exporter wrote URLs as plain
strings where the schema declares `xsd:anyURI` (112 triples) — disjoint value spaces in OWL 2. The
exporter now types every literal from the generated TBox. Re-typed, one genuine error remained: EMBER's
`projects.website` holds prose ("Visit EMBER via the Brain-Behavior Data Archive portal"). Without it
the graph is consistent. Also: `xsd:date` is not in the OWL 2 datatype map, so the reasoner relaxes it.

## Recommendations / next steps

1. ~~Fold `species_aliases` into the resolver~~ / ~~route "no species by design" to `study_scope`~~ **DONE** — F1 is 6.
2. **Confirm the four strong species candidates** and get the two `needs_choice` answers from the project teams (F1) → #7 to 0.
3. **Orphan cleanup + insert trigger** (F3), and promote the 6 backfilled `resource_type` values PROPOSED → shipped in the LinkML once `types.ts` regenerates.
4. **Full-access export run** (Phase 6) — light up #5/#12/#14/#15/#17/#18/#19 against real data; add the OWL reasoner for the `disjoint_with` axioms gen-owl didn't emit.
5. **Data fixes:** normalize `co-investigator`; investigate the 34th Project (orphan grant resource).
