# BBQS Knowledge Graph — Consistency Report

**Date:** 2026-09-21 · **Status:** in progress · **Tracking:** [brain-bbqs/bbqs-app#386](https://github.com/brain-bbqs/bbqs-app/issues/386)

## Executive summary

We can now **generate** a BBQS knowledge graph from the live database and **validate** that it is
internally consistent. The first run produced a ~2,476-triple graph. Folding `species_aliases` into the resolver cut
unresolved `study_species` from 26 to **9** — the genuine data-quality cases (non-species text like
`"All Species"`, plus one real species missing an alias). The role-vocabulary and grant-mechanism
checks pass cleanly — after the run corrected a schema error in our own role vocabulary.

The goal of this effort is **consistency, not completeness**: we validate that parts of the graph do
not contradict each other. Missing detail (a project with no devices, a dataset with no methods) is
*out of scope* — that is a gap, not a contradiction.

## Approach

| Concern | Decision |
|---|---|
| Schema logic | OWL, authored in LinkML (`kg/bbqs.linkml.yaml`) |
| Validation | SHACL first (pyshacl); OWL reasoner (robot/HermiT) later |
| Node spine | Supabase `resources` table — one row = one IRI, `resource_type` = rdf:type |
| Instances | `kg/export.py` walks the spine + typed tables → instance TTL |
| Consistency checks | three layers: Node guards (schema↔DB drift), SHACL shapes (structural + contradiction), OWL reasoning (deferred) |

The full invariant catalog and how to run everything are in [README.md](README.md).

## What was built

- **`kg/bbqs.linkml.yaml`** — 31-class schema rebuilt from the real Supabase schema. One `Project`
  node carries the NIH award as attributes ("Grant" is only NIH terminology). Aligned to
  schema.org + PROV-O + NCBITaxon + Bioschemas/Croissant; neuroscience/Marr layer stubbed.
- **`kg/export.py`** — exporter over the `resources` spine (joins grants ⋈ projects, reifies
  `grant_investigators` as `ProjectRole`, mints non-spine entities).
- **`kg/shapes/consistency.shapes.ttl`** — the contradiction shapes (SHACL/SPARQL).
- **`kg/fixtures/`** + **`kg/validate.py`** — a RED/GREEN fixture pair proving the shapes bite.
- **`tests/guards/kg-resource-type-parity.test.mjs`** — a zero-dep guard that ties the schema's
  node vocabulary to the live Postgres enum (`npm run test:guards`).

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

The 9 that remain are genuine:

- **Missing an alias** (a real species): `Hofstenia miamia` → should map to the *Acoel Worm* node.
  Fix = add the `species_aliases` row.
- **Not a species** (data entered in the wrong place): `All Species` (×2), `Rodents`,
  `Interacting Animals`, `Freely moving animals`, `Genetic Species`, `Developmental Models`,
  `Social species with male displays`.

### F2 — role vocabulary was mis-modelled; one real normalization gap

The schema's `project_role_enum` was wrong (invented hyphenated tokens). The live
`grant_investigators.role` vocabulary is: `contact_pi, co_pi, mpi, trainee, postdoc,
graduate_student, research_staff` — **underscore-separated** — plus the single **hyphenated**
`co-investigator`. The schema/shape are now grounded in these real values, so #4 passes. The
lone hyphenated `co-investigator` is a genuine normalization inconsistency worth a data fix.
(`role_source` is one of `reporter`, `curator`, `funder_notice`.)

### F3 — node-spine gaps

- **34 Project nodes from 33 grants** — one grant is not single-sourced to its spine node
  (a duplicate-node risk; invariant #2). Worth tracing.
- **Organizations (37) and Publications (45) are not in the `resources` spine at all** — they exist
  only in their own tables. The backfill migration should bring them (and species/devices/working
  groups/funding/events) into the spine.

### F4 — coverage limits of this run

The exporter ran as the **anon** role, so RLS hid the `investigators` detail table,
`field_provenance`, `source_classes`, and working groups. Consequently invariant **#5**
(role-column conflation) and **#12** (conflicting verified provenance) had no data to check. A
full-access export run will exercise them.

### F5 — OWL reasoning (HermiT via owlready2): exporter datatype drift + one bad URL

The first reasoner pass found the anon export **inconsistent**. Cause: the exporter wrote URLs as plain
strings where the schema declares `xsd:anyURI` (112 triples) — disjoint value spaces in OWL 2. The
exporter now types every literal from the generated TBox. Re-typed, one genuine error remained: EMBER's
`projects.website` holds prose ("Visit EMBER via the Brain-Behavior Data Archive portal"). Without it
the graph is consistent. Also: `xsd:date` is not in the OWL 2 datatype map, so the reasoner relaxes it.

## Recommendations / next steps

1. ~~Fold `species_aliases` into the exporter's resolver~~ **DONE** — collapsed F1 from 26 to 9.
2. **Full-access export run** — light up invariants #5 and #12 against real data.
3. **Backfill migration** — extend `resource_type` and add `resource_id` so species, devices,
   working groups, funding, events, organizations and publications are first-class spine nodes.
4. **`gen-shacl` / `gen-owl`** — generate the boilerplate shapes (cardinality/pattern/type) and the
   OWL TBox, turning catalog rows 1/2/3/6/8/10/11 from *planned* into enforceable.
5. **Data fixes** surfaced here: normalize `co-investigator`; clean the non-species `study_species`
   entries; investigate the 34th Project node; replace EMBER's prose `website` with a URL (F5).
