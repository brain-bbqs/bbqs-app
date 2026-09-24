# BBQS Knowledge Graph — Consistency Report

**Date:** 2026-09-21 (counts refreshed 2026-09-23) · **Status:** in progress · **Tracking:** [brain-bbqs/bbqs-app#386](https://github.com/brain-bbqs/bbqs-app/issues/386)

## Executive summary

We can now **generate** a BBQS knowledge graph from the live database and **validate** that it is
internally consistent. The first run produced a ~2,476-triple graph; the 2026-09-23 run produced
**3,105**. Folding `species_aliases` into the resolver cut unresolved `study_species` from 26 to **9** —
the genuine data-quality cases (non-species text like `"All Species"`, plus one real species with no
`species` row). That row has since been added (`migration:add_hofstenia_species`), and a re-export
**confirmed 8**: R34DA061984 now resolves. The role-vocabulary and grant-mechanism
checks pass cleanly — after the run corrected a schema error in our own role vocabulary.

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

## Latest run — 2026-09-23

**3,105 triples.** Node counts: Investigator 263, ProjectRole 111, Publication 90,
ResearchOrganization 74, Device 35, Project 34, DeviceCategory 34, Dataset 24, SoftwareTool 19,
Species 14, FundingOpportunity 14, Announcement 12, Job 6, MLModel 3, Benchmark 3, Protocol 1.
ProjectRole edges: 111. Unresolved `study_species`: **9** (see F1).

Species 14 predates the Hofstenia row. A re-export after adding it **confirmed 8 unresolved**: every
remaining value is one of the eight in F1 below, and R34DA061984 no longer appears.

## First run — the graph

~2,476 triples. Node counts: Project 34, ProjectRole 111, Investigator 177, Publication 45,
ResearchOrganization 37, Device 35, DeviceCategory 34, Dataset 24, SoftwareTool 18, Species 14,
Announcement 5, Job 4, MLModel 3, Benchmark 3, Protocol 1.

Validated against the consistency shapes: **`Conforms: False`, 9 violations — all invariant #7**
(dangling `study_species`, after alias resolution). Invariants #4 (canonical role token) and #9
(mechanism↔grant_number) **conform**. #5 and #12 have no targets in this run (see *Coverage limits*).

## Findings

### F1 — `study_species` values that do not resolve to a Species node (invariant #7)

`projects.study_species[]` is free text; the `species` table holds 14 canonical common-name entries.
The exporter now folds `species_aliases` (32 rows) into its resolver and emits each alias onto its
Species node, so scientific names and plurals resolve — cutting the dangling set **from 26 to 9**.
Shape #7 verifies resolution from the graph itself (name / common_name / alias match).

The 9 that remained at the 2026-09-23 run, and what each needs:

| Grant | `study_species` value | Status | Needs |
|---|---|---|---|
| R34DA061984 | `Hofstenia miamia` | **fixed in data** — the alias existed but there was no `species` row; the panther worm row was added (audit actor `migration:add_hofstenia_species`) | nothing — **verified**: resolves on re-export |
| R34DA059723 | `Freely moving animals` | candidate *Mus musculus* (strong) | a curator to confirm |
| R34DA062119 | `Developmental Models` | candidate *Mus musculus* (strong) | a curator to confirm |
| R34DA059512 | `Rodents` | candidate *Mus musculus* (strong) | a curator to confirm |
| R34DA061924 | `Interacting Animals` | candidate *Mustela putorius furo* (strong) | a curator to confirm |
| R34DA059500 | `Genetic Species` | flies **and** fish, neither named to species (`needs_choice`) | the project team to say which |
| R34DA059510 | `Social species with male displays` | Lake Malawi cichlids — a family of hundreds of species (`needs_choice`) | the project team to say which |
| R24MH136632 (EMBER) | `All Species` | infrastructure award | nothing — no species by design |
| U24DA064429 (BARD.CC) | `All Species` | infrastructure award (renumbered from U24MH136628, #385) | nothing — no species by design |

Candidates live in `species_candidates` and are confirmed with `confirm_species_candidate`, which
records the curator as the source. Trajectory: **9 → 8** (Hofstenia — verified) **→ 4** (after the four
strong confirmations: the two choices + the two infrastructure awards remain) **→ 2** (once the
project teams choose). The last 2 are correct data that #7 still flags, because `species_aliases`
marks `All Species` as a placeholder but the exporter does not read `kind` yet.

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

## Recommendations / next steps

1. ~~Fold `species_aliases` into the exporter's resolver~~ **DONE** — collapsed F1 from 26 to 9.
2. **Full-access export run** — light up invariants #5 and #12 against real data.
3. **Backfill migration** — extend `resource_type` and add `resource_id` so species, devices,
   working groups, funding, events, organizations and publications are first-class spine nodes.
4. **`gen-shacl` / `gen-owl`** — generate the boilerplate shapes (cardinality/pattern/type) and the
   OWL TBox, turning catalog rows 1/2/3/6/8/10/11 from *planned* into enforceable.
5. **Data fixes** surfaced here: normalize `co-investigator`; confirm the four strong species
   candidates and get the two `needs_choice` answers from the project teams (F1); investigate the
   34th Project node.
