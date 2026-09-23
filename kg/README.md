# BBQS Knowledge Graph

RDF/OWL knowledge graph of the BBQS consortium. **Current goal: generate a *consistent* graph and
validate that no part contradicts another** — not enrichment. Consistency ≠ completeness; missing
per-project detail is out of scope for now.

## Build phases

**Where we are: Phase 4 (generate OWL/SHACL) done — Phase 5 (backfill migration) next.** This table
is the running status of the whole effort; the Status column is updated as each phase lands.

| # | Phase | Step | Status |
|---|---|---|---|
| 0 | Foundations & decisions — consistency-not-enrichment; LinkML master = source of truth; `resources` spine = node backbone; SHACL-first then OWL; Project=Grant; ontology alignments chosen | — | **done** |
| 1 | Schema authored — `bbqs.linkml.yaml`, DB-grounded, 31 classes, Marr stubbed | — | **done** (v0.3 — keep-list from #397: schema hygiene + `Algorithm`; `title`/DANDI kept, device/SOSA deferred) |
| 2 | Consistency invariants — the 19-row catalogue below; RED/GREEN fixtures; schema↔DB drift guard | — | **done** (11 shapes + 1 guard live) |
| 3 | Exporter — `resources` spine → instance TTL; grants⋈projects; ProjectRole; `species_aliases` resolver; `field_provenance`→PROV | **A** | **done** (3,105 triples on 2026-09-23; 9 dangling, 8 expected after the Hofstenia row) |
| 4 | Generate OWL + boilerplate SHACL from the LinkML (`gen-owl`/`gen-shacl`) | **B** | **done** (`bbqs.owl.ttl` 3,165 triples; `bbqs.shapes.gen.ttl` 22 NodeShapes; `disjoint_with` → `owl:disjointWith` didn't emit — deferred to Phase 6) |
| 5 | Backfill migration — extend `resource_type` + add `resource_id` (species/devices/working-groups/funding/events/orgs/pubs) | **C** | planned |
| 6 | Full-access export + OWL reasoning — light up shapes #5/#12; robot/HermiT consistency pass | — | planned |
| 7 | CI gate — run the harness on fixtures now, the exported graph later | **D** | planned |
| 8 | Publish `/schema` + retire old surfaces — regenerate the tree from the LinkML, retire the old `/schema` data + `/data-model`, unhide when done | **E** | in progress (route admin-gated + WIP banner; tree regen pending) |
| 9 | Spec artifacts in `../bbqs-agent/specs/` | **F** | planned |

## Layout

| Path | What it is |
|---|---|
| `bbqs.linkml.yaml` | **Authoring source of truth.** LinkML vocabulary → generates OWL + SHACL + JSON-LD. |
| `export.py` | Exporter: Supabase `resources` spine → instance TTL (`export/bbqs.ttl`, gitignored). |
| `shapes/consistency.shapes.ttl` | Hand-written SHACL for the cross-field/cross-node **contradiction** checks (what gen-shacl can't produce). |
| `fixtures/contradictions.ttl` | A graph seeded with one violation per consistency shape (the RED case). |
| `fixtures/clean.ttl` | The same graph corrected (the GREEN case). |
| `validate.py` | pyshacl runner: `python kg/validate.py <data.ttl> [shapes…]`. |
| `examples/project-to-triples.md` | Worked example: one project's triples mapped to the spine's identity / type / attachment. |
| `bbqs.owl.ttl` | Generated OWL (`gen-owl`) — the TBox for the Phase 6 reasoner. |
| `bbqs.shapes.gen.ttl` | Generated boilerplate SHACL (`gen-shacl`) — node/cardinality/pattern shapes. |

## The three validation layers

1. **Guards (Node, runnable now, zero-dep)** — schema↔DB drift, e.g. `tests/guards/kg-resource-type-parity.test.mjs` ties this schema's `resource_type_enum` to the live Postgres enum. Runs under `npm run test:guards`.
2. **SHACL (pyshacl)** — structural + contradiction checks over an instance graph. The interesting shapes live in `shapes/`; the boilerplate node/cardinality/pattern shapes come from `gen-shacl` (see below).
3. **OWL reasoning (deferred)** — pure-logic contradictions (disjoint classes, functional properties) via a DL reasoner (robot/HermiT). Needs Java; added after the SHACL layer is green.

## Consistency-invariant catalog

The convergence target: the invariants a generated graph must satisfy to be *consistent*, each mapped
to the layer that enforces it. Consistency is not completeness — rules like "every project has a
device" are **out of scope** (that's missing data, not a contradiction). Tracked in
[#386](https://github.com/brain-bbqs/bbqs-app/issues/386).

| # | Invariant (must hold) | Contradiction it catches | Enforced by | Status |
|---|---|---|---|---|
| 1 | One node has one `resource_type`, matching the table it came from | a `grants` node also typed `investigator` | OWL disjoint + SHACL | planned |
| 2 | One IRI per entity; no two typed rows share a `resource_id` | two rows collapse into one node | SHACL / guard | planned |
| 3 | Core classes mutually disjoint (Person/Org/Dataset/Project/Species/Event) | a node typed Person and Product | OWL `disjointWith` | planned |
| 4 | `ProjectRole.project_role` is a canonical token | role = "Principal Investigator" free text | SHACL `sh:in` | **live** |
| 5 | PI standing comes only from `ProjectRole` (roster), never `consortium_role` | free-text label asserts PI with no roster row (#283) | exporter rule + SHACL | partial |
| 6 | Each `ProjectRole` has one `held_by`, one `on_project`, a `role_source`; `held_by` resolves to an Investigator | dangling / source-less role edge | SHACL + OWL functional | **partial** (`held_by` → Investigator referential shape live; cardinality via gen-shacl) |
| 7 | `studies_species` resolves to a Species node (later: `member_of_group`/`manufacturer`/`award_numbers`) | project studies "Mus musculus" but no such Species node | SHACL SPARQL | **live** (9 real hits, after `species_aliases` resolution) |
| 8 | Working-group tags are canonical (`canonical_working_group`) | non-canonical WG label | SHACL `sh:in` | planned |
| 9 | `mechanism` is consistent with `grant_number` | mechanism `R61` on a `U01...` number | SHACL SPARQL | **live** |
| 10 | Format patterns hold: ORCID, DOI, grant_number, NCBITaxon IRI | malformed ORCID | SHACL `sh:pattern` | planned |
| 11 | Numeric/temporal sanity: amount >= 0, budget_floor <= ceiling, open <= expiration | expiration date before open date | SHACL SPARQL | planned |
| 12 | No two *verified* sources disagree on one field | two trusted `field_provenance` rows conflict | SHACL SPARQL | **live** |
| 13 | Schema `resource_type_enum` == the DB enum | schema/DB drift ("code shipped, migration didn't") | Node guard | **live** |
| 14 | One ORCID → one Investigator node | two Investigator nodes share an `orcid` | SHACL SPARQL | **live** (no targets — anon export omits `orcid`) |
| 15 | One email (primary or secondary) → one Investigator node | same address as one node's `email` and another's `secondary_emails` (the `lyc5332@psu.edu` failure) | SHACL SPARQL | **live** (no targets — `email`/`secondary_emails` are PII, restricted from anon export) |
| 16 | One person has one role per grant (per-edge role is fine across *different* grants) | two `ProjectRole` edges for the same `held_by`+`on_project` pair assert different `project_role` values | SHACL SPARQL | **live** |
| 17 | `Publication.author_orcids` resolves to an Investigator node | an author ORCID with no matching Investigator (graded, not dropped — mirrors #7) | SHACL SPARQL | **live** (no targets — exporter doesn't emit `author_orcids` yet) |
| 18 | A grade-1 (curator) provenance claim is never contradicted by a grade-3 (harvested) claim on the same field | harvested value disagrees with a manually-verified one (field_provenance is append-only) | SHACL SPARQL | **live** (no targets — same RLS gate as #12) |
| 19 | A node cannot exist with zero provenance claims | a node with no `field_provenance` row at all ("unknown" is a value, not an absence) | SHACL SPARQL | **live** (scoped to `Project`; no targets on anon export — same RLS gate as #12) |

**live** = enforced now: 4/5/6(held_by)/7/9/12/14/15/16/17/18/19 in `shapes/consistency.shapes.ttl`,
13 in `../tests/guards/kg-resource-type-parity.test.mjs`. On the current anon export, 4 and 9
conform, 7 fires 9×, `held_by` is omitted (so its shape passes; it fired on 111 pre-fix roles), and
5/12/14/15/17/18/19 have no targets (investigators-detail, `field_provenance`, `orcid`,
`secondary_emails`, and `author_orcids` are either RLS-hidden from anon or not yet emitted by the
exporter — a full-access export, plus wiring `author_orcids` into the exporter, exercises them). 16
conforms on the current export (no two `ProjectRole` edges yet share a `held_by`+`on_project`
pair). **partial** = one half in place — for #5 the
`consortium_role` conflation shape exists, but the exporter's roster-only generation rule is pending.
**planned** = arrives with the `gen-shacl` boilerplate shapes, the full-access export, or the OWL layer.

Rows 14–19 were proposed from an external review (via Lovable) against issue #386; three
overlapping proposals were folded into existing rows instead of duplicated (`roleOnProject`
canonical-token → row 4; working-group canonical labels → row 8; `Grant.funder` typed
`FundingAgency` → already a `gen-shacl` range constraint), and four more were deferred because the
schema doesn't model the fields yet (org name variants and device categories need their
`resource_id` backfill first; grant/publication date-sanity needs `Project.start_date`/`end_date`
and a `Consortium.founding_date` slot that don't exist yet).

## Run the consistency harness

```bash
python -m venv kg/.venv
kg/.venv/Scripts/python -m pip install pyshacl        # Windows; use bin/ on macOS/Linux
kg/.venv/Scripts/python kg/validate.py kg/fixtures/contradictions.ttl   # -> conforms=False (every shape fires)
kg/.venv/Scripts/python kg/validate.py kg/fixtures/clean.ttl            # -> conforms=True
```

## Generate OWL + boilerplate SHACL from the schema

Done — `bbqs.owl.ttl` and `bbqs.shapes.gen.ttl` are committed. To regenerate after editing the schema
(Windows needs `PYTHONUTF8=1`, and the generators write to stdout — `-o` is ignored):

```bash
kg/.venv/Scripts/python -m pip install linkml
PYTHONUTF8=1 kg/.venv/Scripts/gen-owl   kg/bbqs.linkml.yaml > kg/bbqs.owl.ttl
PYTHONUTF8=1 kg/.venv/Scripts/gen-shacl kg/bbqs.linkml.yaml > kg/bbqs.shapes.gen.ttl
```

`gen-shacl` gives the boilerplate node/cardinality/`sh:pattern` shapes (run alongside
`shapes/consistency.shapes.ttl`); `gen-owl` gives the TBox for the Phase 6 reasoner. Note:
`disjoint_with` did not translate to `owl:disjointWith` — deferred to Phase 6.

## Run the exporter

```bash
kg/.venv/Scripts/python kg/export.py            # -> kg/export/bbqs.ttl (+ dangling-species report)
kg/.venv/Scripts/python kg/validate.py kg/export/bbqs.ttl kg/shapes/consistency.shapes.ttl
```

Anon by default (RLS-limited). For the full graph — including investigators-table detail and
`field_provenance` (needed by shapes 5 and 12) — set `SUPABASE_KEY` to a stronger key first.

## Not yet built

- **Full-access export**: run with a key that can read investigators/field_provenance/working groups; promote `working_groups[]` and map `field_provenance` → PROV.
- **Backfill migration**: add `resource_type` values + `resource_id` for species / devices / manufacturers / working groups / funding / events (also: orgs and publications aren't in the spine at all).
- **OWL reasoning layer** (see above).
