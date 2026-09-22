# BBQS Knowledge Graph

RDF/OWL knowledge graph of the BBQS consortium. **Current goal: generate a *consistent* graph and
validate that no part contradicts another** — not enrichment. Consistency ≠ completeness; missing
per-project detail is out of scope for now.

## Layout

| Path | What it is |
|---|---|
| `bbqs.linkml.yaml` | **Authoring source of truth.** LinkML vocabulary → generates OWL + SHACL + JSON-LD. |
| `export.py` | Exporter: Supabase `resources` spine → instance TTL (`export/bbqs.ttl`, gitignored). |
| `shapes/consistency.shapes.ttl` | Hand-written SHACL for the cross-field/cross-node **contradiction** checks (what gen-shacl can't produce). |
| `fixtures/contradictions.ttl` | A graph seeded with one violation per consistency shape (the RED case). |
| `fixtures/clean.ttl` | The same graph corrected (the GREEN case). |
| `validate.py` | pyshacl runner: `python kg/validate.py <data.ttl> [shapes…]`. |

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
| 6 | Each `ProjectRole` has one `held_by`, one `on_project`, a `role_source` | dangling / source-less role edge | SHACL + OWL functional | planned |
| 7 | `studies_species` resolves to a Species node (later: `member_of_group`/`manufacturer`/`award_numbers`) | project studies "Mus musculus" but no such Species node | SHACL SPARQL | **live** (26 real hits) |
| 8 | Working-group tags are canonical (`canonical_working_group`) | non-canonical WG label | SHACL `sh:in` | planned |
| 9 | `mechanism` is consistent with `grant_number` | mechanism `R61` on a `U01...` number | SHACL SPARQL | **live** |
| 10 | Format patterns hold: ORCID, DOI, grant_number, NCBITaxon IRI | malformed ORCID | SHACL `sh:pattern` | planned |
| 11 | Numeric/temporal sanity: amount >= 0, budget_floor <= ceiling, open <= expiration | expiration date before open date | SHACL SPARQL | planned |
| 12 | No two *verified* sources disagree on one field | two trusted `field_provenance` rows conflict | SHACL SPARQL | **live** |
| 13 | Schema `resource_type_enum` == the DB enum | schema/DB drift ("code shipped, migration didn't") | Node guard | **live** |

**live** = enforced now: 4/5/7/9/12 in `shapes/consistency.shapes.ttl`, 13 in
`../tests/guards/kg-resource-type-parity.test.mjs`. On the current anon export, 4 and 9 conform, 7
fires 26×, and 5/12 have no targets (investigators-detail and field_provenance are RLS-hidden from
anon — a full-access export exercises them). **partial** = one half in place — for #5 the
`consortium_role` conflation shape exists, but the exporter's roster-only generation rule is pending.
**planned** = arrives with the `gen-shacl` boilerplate shapes, the full-access export, or the OWL layer.

## Run the consistency harness

```bash
python -m venv kg/.venv
kg/.venv/Scripts/python -m pip install pyshacl        # Windows; use bin/ on macOS/Linux
kg/.venv/Scripts/python kg/validate.py kg/fixtures/contradictions.ttl   # -> conforms=False, 4 results
kg/.venv/Scripts/python kg/validate.py kg/fixtures/clean.ttl            # -> conforms=True
```

## Generate OWL + boilerplate SHACL from the schema (once linkml is installed)

```bash
kg/.venv/Scripts/python -m pip install linkml
gen-owl   kg/bbqs.linkml.yaml > kg/bbqs.owl.ttl
gen-shacl kg/bbqs.linkml.yaml > kg/bbqs.shapes.gen.ttl   # validate alongside shapes/consistency.shapes.ttl
```

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
