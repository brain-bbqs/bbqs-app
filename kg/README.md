# BBQS Knowledge Graph

RDF/OWL knowledge graph of the BBQS consortium. **Current goal: generate a *consistent* graph and
validate that no part contradicts another** — not enrichment. Consistency ≠ completeness; missing
per-project detail is out of scope for now.

## Build phases

**Where we are: Phase 5 (backfill + spine-first exporter) in progress.** This table is the running
status of the whole effort; the Status column is updated as each phase lands.

| # | Phase | Step | Status |
|---|---|---|---|
| 0 | Foundations & decisions — consistency-not-enrichment; LinkML master = source of truth; `resources` spine = node backbone; SHACL-first then OWL; Project=Grant; ontology alignments chosen | — | **done** |
| 1 | Schema authored — `bbqs.linkml.yaml`, DB-grounded, 31 classes, Marr stubbed | — | **done** (v0.3 — keep-list from #397: schema hygiene + `Algorithm`; `title`/DANDI kept, device/SOSA deferred) |
| 2 | Consistency invariants — the 19-row catalogue below; RED/GREEN fixtures; schema↔DB drift guard | — | **done** (11 shapes + 1 guard live) |
| 3 | Exporter — `resources` spine → instance TTL; grants⋈projects; ProjectRole; `species_aliases` resolver; `field_provenance`→PROV | **A** | **done** (3,105 triples on 2026-09-23; 8 dangling after the Hofstenia row, verified) |
| 4 | Generate OWL + boilerplate SHACL from the LinkML (`gen-owl`/`gen-shacl`) | **B** | **done** (`bbqs.owl.ttl` 3,165 triples; `bbqs.shapes.gen.ttl` 22 NodeShapes; `disjoint_with` → `owl:disjointWith` didn't emit — deferred to Phase 6) |
| 5 | Backfill migration — extend `resource_type` + add `resource_id` (species/devices/working-groups/funding/events/orgs/pubs) | **C** | **in progress** (backfill landed via #386; exporter now spine-sources every entity and the `project` double-node is resolved; remaining: orphan cleanup, `types.ts` regen → promote the 6 enum values, insert trigger) |
| 6 | Full-access export + OWL reasoning — light up shapes #5/#12; robot/HermiT consistency pass | — | planned |
| 7 | CI gate — run the harness on fixtures now, the exported graph later | **D** | planned |
| 8 | Publish `/schema` + retire old surfaces — regenerate the tree from the LinkML, retire the old `/schema` data + `/data-model`, unhide when done | **E** | in progress (route admin-gated + WIP banner; tree regen pending) |
| 9 | Spec artifacts in `../bbqs-agent/specs/` | **F** | planned |

## Layout

| Path | What it is |
|---|---|
| `bbqs.linkml.yaml` | **Authoring source of truth.** LinkML vocabulary → generates OWL + SHACL + JSON-LD. |
| `bbqs_kg.py` | `BBQSKnowledgeGraph` — one class wrapping the exporter and the validator as methods (`export()`, `validate()`, `run()`), taking/returning `pathlib.Path`. `export.py`/`validate.py`/`main.py` are thin `click` CLIs over it (each also takes `--help`). |
| `export.py` | Exporter CLI: Supabase `resources` spine → instance TTL (`export/bbqs.ttl`, gitignored). |
| `shapes/consistency.shapes.ttl` | Hand-written SHACL for the cross-field/cross-node **contradiction** checks (what gen-shacl can't produce). |
| `fixtures/contradictions.ttl` | A graph seeded with one violation per consistency shape (the RED case). |
| `fixtures/clean.ttl` | The same graph corrected (the GREEN case). |
| `validate.py` | pyshacl runner CLI: `python kg/validate.py <data.ttl> [shapes…]`. |
| `main.py` | Runs the whole pipeline in one call: export, validate, then build the Explorer JSON (`python kg/main.py`). |
| `examples/project-to-triples.md` | Worked example: one project's triples mapped to the spine's identity / type / attachment. |
| `bbqs.owl.ttl` | Generated OWL (`gen-owl`) — the TBox for the Phase 6 reasoner. |
| `bbqs.shapes.gen.ttl` | Generated boilerplate SHACL (`gen-shacl`) — node/cardinality/pattern shapes. |
| `explorer.py` | Builds `bbqs_explorer.json` for `explorer/index.html`: `BBQSKnowledgeGraph.export_explorer_json()` CLI. |
| `explorer_geocode.py` | Curated `org name -> (lat, lng)` table for the Explorer's globe/map views. |
| `explorer/index.html` | **BBQS Explorer** — single-file D3 v7 app: draggable globe → US map → triple/relationship panel. No build step. |

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
| 7 | `studies_species` resolves to a Species node (later: `member_of_group`/`manufacturer`/`award_numbers`) | project studies "Mus musculus" but no such Species node | SHACL SPARQL | **live** (6 real hits; `species_aliases` resolves synonyms, and "no species by design" values like "All Species" route to `study_scope` instead of being flagged) |
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

## Run the consistency harness

```bash
python -m venv kg/.venv
kg/.venv/Scripts/python -m pip install pyshacl click  # Windows; use bin/ on macOS/Linux
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

## Run the whole pipeline

One `BBQSKnowledgeGraph` object (`bbqs_kg.py`), one command: exports from Supabase, validates the
result against the SHACL shapes, and builds the BBQS Explorer JSON (`explorer/index.html`'s
draggable globe → US map → triple/relationship panel), in that order.

```bash
kg/.venv/Scripts/python kg/main.py
```

That writes `kg/export/bbqs.ttl`, prints the SHACL validation report, and writes
`kg/explorer/bbqs_explorer.json` — then serve `kg/explorer/` (`python -m http.server` from that
directory, not a `file://` open) to browse it. Same thing from Python:

```python
from bbqs_kg import BBQSKnowledgeGraph
BBQSKnowledgeGraph().run()   # export() -> validate() -> export_explorer_json(), returns conforms
```

Anon by default (RLS-limited). Pass `BBQSKnowledgeGraph(url=..., key=...)`, or set `SUPABASE_KEY` to
a stronger key, for the full graph — including investigators-table detail and `field_provenance`
(needed by shapes 5 and 12). `export.py`/`validate.py`/`explorer.py` remain as individual CLIs over
the same object for running one step at a time.

## Not yet built

- **Phase 5 cleanup**: remove the orphan `resources` rows the backfill left (~14 `investigator` + 1 `grant` that point at no table row); add an insert trigger so new rows get a `resource_id` automatically; and once `types.ts` is regenerated, promote the 6 backfilled `resource_type` values from PROPOSED → shipped in the LinkML (the parity guard will flag it).
- **Full-access export**: run with a key that can read investigators / field_provenance / working-group detail; map `field_provenance` → PROV (needed by shapes 5 and 12).
- **OWL reasoning layer** (see above) — includes the `owl:disjointWith` axioms gen-owl didn't emit.
