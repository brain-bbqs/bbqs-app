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

### Why each phase

- **0 — Foundations.** Locked the goal (*consistency, not enrichment*), and the four choices everything else depends on: LinkML as the single source of truth, the `resources` table as the node spine, SHACL-first validation, and `Project`=`Grant` as one node. *Why:* a KG drifts without one rule for identity, typing, and schema; deciding these up front keeps every later phase mechanical, and the consistency-not-completeness framing bounds the scope to contradictions we can actually detect.
- **1 — Schema authored.** Wrote `bbqs.linkml.yaml` with one class per real entity, grounded in the actual Supabase columns; the Marr/causal layer is stubbed. *Why:* LinkML is the one artifact that generates OWL + SHACL + JSON-LD, so we author once instead of hand-syncing three formats. Grounding in real columns means the schema describes what exists; stubbing Marr avoids modeling a layer that isn't ready.
- **2 — Consistency invariants.** The 19-row catalogue of what must not contradict, RED/GREEN fixtures, and a zero-dep schema↔DB drift guard. *Why:* "consistent" is meaningless without a written list of the specific contradictions we reject; proving each shape RED first means a green result actually means something; the guard catches enum drift in CI before it reaches the graph.
- **3 — Exporter (A).** Walk the spine → instance TTL (grants⋈projects, reified `ProjectRole`, `species_aliases` resolver, `field_provenance`→PROV). *Why:* you cannot validate a graph you haven't generated — this is the "generate" half. Running it on real data immediately surfaced real bugs (9 dangling species; the `held_by` two-keys identity error), which is the entire point.
- **4 — Generate OWL + boilerplate SHACL (B).** `gen-owl` → the TBox; `gen-shacl` → node/cardinality/pattern shapes. *Why:* the hand-written shapes cover only cross-field contradictions; the mechanical structural checks should be *generated* from the schema so they can never drift from it, and the OWL TBox is the input the Phase 6 reasoner needs.
- **5 — Backfill migration (C).** Extend `resource_type` + add `resource_id` so species/devices/working-groups/funding/events/orgs/pubs enter the spine. *Why:* the spine is only a real spine if every entity is in it. Today several live only in satellite tables, forcing the exporter to mint IRIs two ways — the migration makes identity single-sourced, which is what makes "one IRI per entity" enforceable.
- **6 — Full-access export + OWL reasoning.** Re-run the exporter with a key that can read RLS-hidden tables, then add a DL reasoner. *Why:* the anon export can't see investigators-detail / `field_provenance`, so shapes #5/#12 have no data; full access exercises them. OWL reasoning catches logical contradictions (disjointness, functional properties) SHACL only approximates — and closes the `disjoint_with` gap Phase 4 surfaced.
- **7 — CI gate (D).** Run the harness in CI (fixtures now, exported graph later). *Why:* a consistency check that isn't automated rots; a gate makes a schema or graph regression fail loudly, matching the repo's guard culture.
- **8 — Publish `/schema` + retire old surfaces (E).** Regenerate the browsable schema tree from the LinkML and retire the hand-maintained `/schema` + `/data-model` pages. *Why:* those old pages are forks of the schema that drift; regenerating from the master gives one source. `/schema` is admin-gated + WIP-bannered meanwhile so we don't publish a half-migrated schema.
- **9 — Spec artifacts (F).** `spec.md`/`plan.md`/`tasks.md`/`qa-itinerary.md` in `../bbqs-agent/specs/`. *Why:* the Constitution requires changes here to leave spec artifacts there, capturing the reasoning as durable spec rather than only commit messages — the exact gap that let issue #283 happen.

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
| `main.py` | Runs the pipeline end-to-end in one call: export, then validate the result (`python kg/main.py [out.ttl]`). |
| `examples/project-to-triples.md` | Worked example: one project's triples mapped to the spine's identity / type / attachment. |
| `bbqs.owl.ttl` | Generated OWL (`gen-owl`) — the TBox for the Phase 6 reasoner. |
| `bbqs.shapes.gen.ttl` | Generated boilerplate SHACL (`gen-shacl`) — node/cardinality/pattern shapes. |
| `explorer.py` | Builds `bbqs_explorer.json` for `explorer/index.html`: `BBQSKnowledgeGraph.export_explorer_json()` CLI. |
| `explorer_geocode.py` | Curated `org name -> (lat, lng)` table for the Explorer's globe/map views (see "BBQS Explorer" below). |
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

## Run the exporter

```bash
kg/.venv/Scripts/python kg/export.py            # -> kg/export/bbqs.ttl (+ dangling-species report)
kg/.venv/Scripts/python kg/validate.py kg/export/bbqs.ttl kg/shapes/consistency.shapes.ttl
```

Or run both steps in sequence with one call, via the `BBQSKnowledgeGraph` object the two CLIs above
share (`bbqs_kg.py`):

```bash
kg/.venv/Scripts/python kg/main.py              # export -> kg/export/bbqs.ttl, then validate it
```

Anon by default (RLS-limited). For the full graph — including investigators-table detail and
`field_provenance` (needed by shapes 5 and 12) — set `SUPABASE_KEY` to a stronger key first.

## Use `BBQSKnowledgeGraph` directly

`export.py`/`validate.py`/`main.py` are CLIs over one object — `bbqs_kg.py`'s `BBQSKnowledgeGraph`.
Import it directly to call `export()`/`validate()` from other Python code (a notebook, another
script, a CI job) instead of shelling out:

```python
import sys
sys.path.insert(0, "kg")          # or run from inside kg/, or add kg/ to PYTHONPATH
from bbqs_kg import BBQSKnowledgeGraph

kg = BBQSKnowledgeGraph()                  # reads SUPABASE_URL/SUPABASE_KEY from the environment,
                                            # falling back to the anon values in
                                            # src/integrations/supabase/client.ts
out_path = kg.export("kg/export/bbqs.ttl")           # -> Path; builds kg.graph (an rdflib.Graph)
conforms, report = BBQSKnowledgeGraph.validate(out_path)   # validate() is a staticmethod

# or both steps in one call:
conforms = kg.run("kg/export/bbqs.ttl")    # export() then validate(); returns the bool
```

Pass `BBQSKnowledgeGraph(url=..., key=...)` to point at a different Supabase project or use a
stronger key (e.g. the full-access export) without touching the environment.

## BBQS Explorer

A single lightweight `explorer/index.html` (D3 v7 from CDN, no build step) with three linked views:
draggable globe → US site map → triple/relationship panel. It reads `bbqs_explorer.json`, built by
`BBQSKnowledgeGraph.export_explorer_json()` — a method on the same object as `export()`/`validate()`,
not a separate one-off script.

Two gaps in the instance data matter for a map, and the exporter closes both **explicitly** rather
than pretending the edges are there:

- **No coordinates.** `ResearchOrganization` nodes carry a name only. `explorer_geocode.py` is a
  curated, hand-maintained `org name -> (lat, lng)` table (city-level, not a runtime geocoding API or
  key — these are well-known US institutions, so a static lookup is lighter and more reliable). Any
  org not in the table lands in `unplaced_orgs` in the JSON and in the Explorer's sidebar, never
  silently dropped.
- **No project↔organization edge.** `part_of_org`/`held_by` are asserted in the LinkML schema but
  absent from every export so far (`grep -c bbqs:part_of_org kg/export/bbqs.ttl` is `0`), and
  `grants`/`projects` don't carry an organization column either — the awardee institution isn't
  anywhere in bbqs.ttl or the Supabase tables this exporter reads. The only place it exists is NIH
  RePORTER's public API, keyed by `reporter_project_num`, so `export_explorer_json()` looks it up
  there once per project (no key needed) and tags the result a **derived** edge (`awarded_to`,
  rendered dashed in the UI) — never mixed with an asserted triple. A project whose RePORTER lookup
  fails (no `reporter_project_num`, network error, no match) lands in `unplaced_projects`, visible in
  the sidebar with why.
- **Project↔project affinity** is derived the same explicit way, from what projects already share in
  the graph: a `species_affinity` edge when two projects resolve to the same `studies_species` node,
  and a `keyword_affinity` edge when two projects' `keywords` overlap by 2 or more (a floor so 34
  projects don't turn into a hairball).

Build it:

```bash
kg/.venv/Scripts/python kg/explorer.py                              # export -> kg/explorer/bbqs_explorer.json
kg/.venv/Scripts/python kg/explorer.py --from-ttl kg/export/bbqs.ttl # reuse an existing export instead
```

Then serve `kg/explorer/` and open it (`python -m http.server` from that directory, not a `file://`
open, so the page's `fetch("bbqs_explorer.json")` works). `bbqs_explorer.json` is committed, same as
`export/bbqs.ttl`, so the page works out of the box; regenerate it whenever `export/bbqs.ttl` changes.

## Not yet built

- **Phase 5 cleanup**: remove the orphan `resources` rows the backfill left (~14 `investigator` + 1 `grant` that point at no table row); add an insert trigger so new rows get a `resource_id` automatically; and once `types.ts` is regenerated, promote the 6 backfilled `resource_type` values from PROPOSED → shipped in the LinkML (the parity guard will flag it).
- **Full-access export**: run with a key that can read investigators / field_provenance / working-group detail; map `field_provenance` → PROV (needed by shapes 5 and 12).
- **OWL reasoning layer** (see above) — includes the `owl:disjointWith` axioms gen-owl didn't emit.
