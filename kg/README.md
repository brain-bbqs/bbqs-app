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
| 2 | Consistency invariants — the 13-row catalogue below; RED/GREEN fixtures; schema↔DB drift guard | — | **done** (5 shapes + 1 guard live) |
| 3 | Exporter — `resources` spine → instance TTL; grants⋈projects; ProjectRole; `species_aliases` resolver; `field_provenance`→PROV | **A** | **done** (2,476 triples; 9 dangling) |
| 4 | Generate OWL + boilerplate SHACL from the LinkML (`gen-owl`/`gen-shacl`) | **B** | **done** (`bbqs.owl.ttl` 3,165 triples; `bbqs.shapes.gen.ttl` 22 NodeShapes; `disjoint_with` → `owl:disjointWith` didn't emit — deferred to Phase 6) |
| 5 | Backfill migration — extend `resource_type` + add `resource_id` (species/devices/working-groups/funding/events/orgs/pubs) | **C** | planned |
| 6 | Full-access export + OWL reasoning — light up shapes #5/#12; robot/HermiT consistency pass | — | **harness done** (`reason.py` = owlready2 + bundled HermiT; `owl/disjointness.ttl` closes the `disjoint_with` gap; 5 RED fixtures fire; exporter now types literals from the TBox). Real-graph run waits on Phase 5 + a full-access key |
| 7 | CI gate — run the harness on fixtures now, the exported graph later | **D** | planned |
| 8 | Publish `/schema` + retire old surfaces — regenerate the tree from the LinkML, retire the old `/schema` data + `/data-model`, unhide when done | **E** | in progress (route admin-gated + WIP banner; tree regen pending) |
| 9 | Spec artifacts in `../bbqs-agent/specs/` | **F** | planned |

### Why each phase

- **0 — Foundations.** Locked the goal (*consistency, not enrichment*), and the four choices everything else depends on: LinkML as the single source of truth, the `resources` table as the node spine, SHACL-first validation, and `Project`=`Grant` as one node. *Why:* a KG drifts without one rule for identity, typing, and schema; deciding these up front keeps every later phase mechanical, and the consistency-not-completeness framing bounds the scope to contradictions we can actually detect.
- **1 — Schema authored.** Wrote `bbqs.linkml.yaml` with one class per real entity, grounded in the actual Supabase columns; the Marr/causal layer is stubbed. *Why:* LinkML is the one artifact that generates OWL + SHACL + JSON-LD, so we author once instead of hand-syncing three formats. Grounding in real columns means the schema describes what exists; stubbing Marr avoids modeling a layer that isn't ready.
- **2 — Consistency invariants.** The 13-row catalogue of what must not contradict, RED/GREEN fixtures, and a zero-dep schema↔DB drift guard. *Why:* "consistent" is meaningless without a written list of the specific contradictions we reject; proving each shape RED first means a green result actually means something; the guard catches enum drift in CI before it reaches the graph.
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
| `export.py` | Exporter: Supabase `resources` spine → instance TTL (`export/bbqs.ttl`, gitignored). |
| `shapes/consistency.shapes.ttl` | Hand-written SHACL for the cross-field/cross-node **contradiction** checks (what gen-shacl can't produce). |
| `fixtures/contradictions.ttl` | A graph seeded with one violation per consistency shape (the RED case). |
| `fixtures/clean.ttl` | The same graph corrected (the GREEN case). |
| `validate.py` | pyshacl runner: `python kg/validate.py <data.ttl> [shapes…]`. |
| `examples/project-to-triples.md` | Worked example: one project's triples mapped to the spine's identity / type / attachment. |
| `bbqs.owl.ttl` | Generated OWL (`gen-owl`) — the TBox for the Phase 6 reasoner. |
| `bbqs.shapes.gen.ttl` | Generated boilerplate SHACL (`gen-shacl`) — node/cardinality/pattern shapes. |
| `owl/disjointness.ttl` | Hand-written OWL axioms gen-owl can't produce: every node class pairwise disjoint (#1/#3) + the dropped `Person ⊥ Organization`. Kept honest by `tests/guards/kg-owl-disjointness.test.mjs`. |
| `reason.py` | OWL consistency runner (owlready2 → HermiT): `python kg/reason.py <data.ttl>`; `--expect-inconsistent` for RED fixtures. |
| `fixtures/owl/` | One contradiction per file — each must reason INCONSISTENT. |

## The three validation layers

1. **Guards (Node, runnable now, zero-dep)** — schema↔DB drift, e.g. `tests/guards/kg-resource-type-parity.test.mjs` ties this schema's `resource_type_enum` to the live Postgres enum. Runs under `npm run test:guards`.
2. **SHACL (pyshacl)** — structural + contradiction checks over an instance graph. The interesting shapes live in `shapes/`; the boilerplate node/cardinality/pattern shapes come from `gen-shacl` (see below).
3. **OWL reasoning (`reason.py`)** — pure-logic contradictions via the HermiT DL reasoner, driven from
   Python by **owlready2** (which bundles the HermiT jar; needs Java on PATH — no separate robot
   install). OWL is the *logic* of the schema: SHACL checks what a node *has*; the reasoner checks
   what the graph *entails* and whether those entailments contradict. Example: a `held_by` edge
   pointing at a Project. SHACL sees "target isn't typed Investigator"; OWL infers the target *is* an
   Investigator (the range) *and* a Project, which are disjoint → inconsistent. Result is one bit per
   graph (consistent or not) — HermiT gives no justification, so on failure `reason.py` prints a
   heuristic list of likely culprits.

   Two things differ from plain OWL semantics, both deliberate: the data individuals are declared
   `owl:AllDifferent` (OWL has no unique-name assumption, so two `held_by` values on a max-1 slot would
   be *merged*, not flagged — our spine guarantees one IRI per entity), and `xsd:date` is relaxed to
   `rdfs:Literal` (it isn't in the OWL 2 datatype map; HermiT rejects it).

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

**live** = enforced now: 4/5/6(held_by)/7/9/12 in `shapes/consistency.shapes.ttl`, 13 in
`../tests/guards/kg-resource-type-parity.test.mjs`. On the current anon export, 4 and 9 conform, 7
fires 9×, `held_by` is omitted (so its shape passes; it fired on 111 pre-fix roles), and 5/12 have
no targets (investigators-detail and field_provenance are RLS-hidden from anon — a full-access
export exercises them). **partial** = one half in place — for #5 the
`consortium_role` conflation shape exists, but the exporter's roster-only generation rule is pending.
**planned** = arrives with the `gen-shacl` boilerplate shapes, the full-access export, or the OWL layer.

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

## Run the OWL reasoner

```bash
kg/.venv/Scripts/python -m pip install owlready2        # + Java 8+ on PATH
kg/.venv/Scripts/python kg/reason.py --expect-inconsistent kg/fixtures/owl/*.ttl   # -> 5x INCONSISTENT
kg/.venv/Scripts/python kg/reason.py kg/fixtures/clean.ttl                          # -> consistent
kg/.venv/Scripts/python kg/reason.py kg/export/bbqs.ttl
```

`fixtures/contradictions.ttl` reasons *consistent* — expected: its violations (free-text role token,
mechanism mismatch, conflicting provenance) are SHACL's job, not logic contradictions.

First run on the anon export (2,365 triples) found:
- **Datatype drift in the exporter** — URLs emitted as plain strings where the schema says
  `xsd:anyURI` (112 triples); disjoint value spaces in OWL 2, so the whole graph was inconsistent.
  Fixed: `export.py` now takes every literal's datatype from `bbqs.owl.ttl`. (`award_amount` as
  integer vs float also drifted, but HermiT accepts it; fixed by the same change.)
- **A real data error** — EMBER's `projects.website` is the prose "Visit EMBER via the
  Brain-Behavior Data Archive portal", not a URL. Needs a data fix.
- With both corrected, the graph is **consistent** (≈3.5 s).

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
- **OWL reasoning on the real graph** — the harness is built; the meaningful run is after the backfill (more node types → more disjointness to violate) with a full-access key (`held_by` edges only exist then).
