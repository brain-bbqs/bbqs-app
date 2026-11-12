# BBQS Knowledge Graph

RDF/OWL knowledge graph of the BBQS consortium. **Goal: a graph that maps one-to-one onto the
database, in both directions (the database could be rebuilt from it), and in which no part
contradicts another.** Consistency is checked by the shapes; completeness by the
[round trip](#round-trip-the-graph-must-be-able-to-rebuild-the-database).

## Build phases

**Where we are:** Phase 5 cleanup is outstanding. The first quality pass landed (#420) and showed
the graph is mostly unlinked. Next: export the edge tables (#421) and one IRI convention (#422).
This table is the running status of the whole effort, updated as each phase lands.

| # | Phase | Step | Status |
|---|---|---|---|
| 0 | Foundations & decisions — consistency-not-enrichment; LinkML master = source of truth; `resources` spine = node backbone; SHACL-first then OWL; Project=Grant; ontology alignments chosen | — | **done** |
| 1 | Schema authored — `bbqs.linkml.yaml`, DB-grounded, 31 classes, Marr stubbed | — | **done** (v0.3 — keep-list from #397: schema hygiene + `Algorithm`; `title`/DANDI kept, device/SOSA deferred) |
| 2 | Consistency invariants — the 19-row catalogue below; RED/GREEN fixtures; schema↔DB drift guard | — | **done** (16 shapes + 2 guards; on the anon export 7 shapes have data to check — see [QA](#quality-evaluation)) |
| 3 | Exporter — `resources` spine → instance TTL; grants⋈projects; ProjectRole; `species_aliases` resolver; `field_provenance`→PROV | **A** | **done**: 5,039 triples, 868 links of ten kinds; 189 of 808 nodes (23%) still isolated, mostly records with nothing to link to (#421) |
| 4 | Generate OWL + boilerplate SHACL from the LinkML (`gen-owl`/`gen-shacl`) | **B** | **done**, with a gap: generated SHACL uses `slot_uri` IRIs the export doesn't, so it targets nothing (#422); `disjoint_with` → `owl:disjointWith` didn't emit |
| 5 | Backfill migration — extend `resource_type` + add `resource_id` (species/devices/working-groups/funding/events/orgs/pubs) | **C** | **in progress** (backfill landed via #386; exporter now spine-sources every entity and the `project` double-node is resolved; remaining: orphan cleanup, `types.ts` regen → promote the 6 enum values, insert trigger) |
| QA | Quality evaluation — the six [QA steps](#qa-steps): competency questions, structure, conformance, consistency, accuracy, coverage | — | **in progress** (steps 1, 2 and shape coverage live in `quality.py`, #420; 3 → #422; 5 and 6 planned) |
| 6 | Full-access export + OWL reasoning — light up shapes #5/#12/#14–#19; HermiT consistency pass | — | **partial** (`reason()` added in #417; not gating, needs a Java runtime, no `owl:disjointWith` axioms yet; full-access export not run) |
| 7 | CI gate — run the harness on fixtures now, the exported graph later | **D** | **done** (`.github/workflows/kg.yml` + `ci_check.py`; the `dev` ruleset requires a PR, code-owner review for `kg/`, and the `kg` check, for everyone including admins, #423) |
| 8 | Publish `/schema` + retire old surfaces — regenerate the tree from the LinkML, retire the old `/schema` data + `/data-model`, unhide when done | **E** | in progress (route admin-gated + WIP banner; tree regen pending) |
| 9 | Spec artifacts in `../bbqs-agent/specs/` | **F** | planned |

### Why each phase

- **0 — Foundations.** Locked the goal (*consistency, not enrichment*), and the four choices everything else depends on: LinkML as the single source of truth, the `resources` table as the node spine, SHACL-first validation, and `Project`=`Grant` as one node. *Why:* a KG drifts without one rule for identity, typing, and schema; deciding these up front keeps every later phase mechanical, and the consistency-not-completeness framing bounds the scope to contradictions we can actually detect.
- **1 — Schema authored.** Wrote `bbqs.linkml.yaml` with one class per real entity, grounded in the actual Supabase columns; the Marr/causal layer is stubbed. *Why:* LinkML generates both the OWL TBox and the structural SHACL, so we author the schema once instead of hand-syncing formats. Grounding in real columns means the schema describes what exists; stubbing Marr avoids modeling a layer that isn't ready. *Caveat:* the exporter is still a hand-written fourth consumer: its class and predicate IRIs are hard-coded, not derived from the LinkML, and they have drifted from what gen-shacl emits. #422 closes that. No JSON-LD context is generated yet.
- **2 — Consistency invariants.** The 19-row catalogue of what must not contradict, RED/GREEN fixtures, and a zero-dep schema↔DB drift guard. *Why:* "consistent" is meaningless without a written list of the specific contradictions we reject; proving each shape RED first means a green result actually means something; the guard catches enum drift in CI before it reaches the graph.
- **3 — Exporter (A).** Walk the spine → instance TTL (grants⋈projects, reified `ProjectRole`, `species_aliases` resolver, `field_provenance`→PROV). *Why:* you cannot validate a graph you haven't generated — this is the "generate" half. Running it on real data immediately surfaced real bugs (9 dangling species; the `held_by` two-keys identity error), which is the entire point.
- **4 — Generate OWL + boilerplate SHACL (B).** `gen-owl` → the TBox; `gen-shacl` → node/cardinality/pattern shapes. *Why:* the hand-written shapes cover only cross-field contradictions; the mechanical structural checks should be *generated* from the schema so they can never drift from it, and the OWL TBox is the input the Phase 6 reasoner needs.
- **5 — Backfill migration (C).** Extend `resource_type` + add `resource_id` so species/devices/working-groups/funding/events/orgs/pubs enter the spine. *Why:* the spine is only a real spine if every entity is in it. Before this, several lived only in satellite tables, forcing the exporter to mint IRIs two ways — the migration makes identity single-sourced, which is what makes "one IRI per entity" enforceable.
- **QA — Quality evaluation.** Six checks beyond consistency: can the graph answer its questions, is it connected, do its artifacts agree, did each shape have data, does it match the source, how full is it. *Why:* consistency alone can pass on an empty or disconnected graph. The first pass showed exactly that: 6 violations, but 65% of nodes isolated and 9 of 12 shapes passing with nothing to check. Measuring this is what stops "no contradictions" from being read as "complete".
- **6 — Full-access export + OWL reasoning.** Re-run the exporter with a key that can read RLS-hidden tables, then add a DL reasoner. *Why:* the anon export can't see investigators-detail / `field_provenance`, so shapes #5/#12 have no data; full access exercises them. The reasoner catches what SHACL can't: disjoint classes, and literals outside their datatype. It does not catch cardinality or range mismatches between IRIs; OWL has no unique-name assumption and infers `sameAs` or a type instead, so those stay SHACL's job.
- **7 — CI gate (D).** Run the harness in CI (fixtures now, exported graph later). *Why:* a consistency check that isn't automated rots; a gate makes a schema or graph regression fail loudly, matching the repo's guard culture.
- **8 — Publish `/schema` + retire old surfaces (E).** Regenerate the browsable schema tree from the LinkML and retire the hand-maintained `/schema` + `/data-model` pages. *Why:* those old pages are forks of the schema that drift; regenerating from the master gives one source. `/schema` is admin-gated + WIP-bannered meanwhile so we don't publish a half-migrated schema.
- **9 — Spec artifacts (F).** `spec.md`/`plan.md`/`tasks.md`/`qa-itinerary.md` in `../bbqs-agent/specs/`. *Why:* the Constitution requires changes here to leave spec artifacts there, capturing the reasoning as durable spec rather than only commit messages — the exact gap that let issue #283 happen.

## Run the whole pipeline

One `BBQSKnowledgeGraph` object (`bbqs_kg.py`), one command, four steps in order:

1. **`export()`** — pull from Supabase into instance Turtle (`kg/export/bbqs.ttl`).
2. **`validate()`** — check that export against the SHACL consistency shapes.
3. **`reason()`** — check the export + the OWL TBox (`bbqs.owl.ttl`) for logical contradictions
   with a DL reasoner (HermiT, via `owlready2`): disjoint classes and literals outside their
   datatype, which SHACL's shape checks can't catch.
4. **`export_explorer_json()`** — build the BBQS Explorer JSON (`explorer/index.html`'s draggable
   globe → US map → triple/relationship panel) from the same graph.

```bash
python -m venv kg/.venv
kg/.venv/Scripts/python -m pip install pyshacl owlready2 click  # Windows; use bin/ on macOS/Linux
kg/.venv/Scripts/python kg/main.py
```

Same thing from Python:

```python
from bbqs_kg import BBQSKnowledgeGraph
BBQSKnowledgeGraph().run()   # export() -> validate() -> reason() -> export_explorer_json()
```

Anon by default (RLS-limited). Pass `BBQSKnowledgeGraph(url=..., key=...)`, or set `SUPABASE_KEY` to
a stronger key, for the full graph — including investigators-table detail and `field_provenance`
(needed by shapes 5 and 12). `export.py`/`validate.py`/`reason.py`/`explorer.py` remain as
individual CLIs over the same object for running one step at a time; `python kg/validate.py
kg/fixtures/clean.ttl` (and `kg/fixtures/contradictions.ttl`, which should fire every shape) proves
the SHACL shapes themselves are correct without a live Supabase export.

`reason()` needs a Java runtime installed separately (`owlready2` ships the HermiT jar, not Java).
Its result is printed but doesn't gate the pipeline's exit code yet: `bbqs.owl.ttl` has no
`owl:disjointWith` axioms (`gen-owl` didn't emit them — a known LinkML-generator gap), so there's
nothing for it to catch at the *class* level today. It returns `consistent=None` (exit 2) when HermiT
errors out; a Java error is not a verdict about the graph.

The current export does hold two values in `xsd:anyURI`-typed fields that are not URIs: one
`Job.external_url` with two links joined by `" ; "`, and `Project.website` on EMBER (R24MH136632)
holding a sentence. Those are Supabase data-entry mistakes to fix upstream, not exporter bugs.

## CI gate

`.github/workflows/kg.yml` runs `ci_check.py` on every PR that touches `kg/` (other PRs pass in
seconds, so the `kg` check can be required). It fails on a **regression**, never on a known gap:

1. every consistency shape still fires on `fixtures/contradictions.ttl` (RED);
2. `fixtures/clean.ttl` still conforms (GREEN);
3. no shape fires on `export/bbqs.ttl` more often than `quality_baseline.json` allows;
4. every competency question answered in the baseline still answers, and every shape that had data
   to check still does;
5. `bbqs.owl.ttl` / `bbqs.shapes.gen.ttl` are what the pinned `gen-owl` / `gen-shacl` produce
   from `bbqs.linkml.yaml` (`--check-generated`).

It also posts the `quality.py` summary to the run, and validates a fresh anon export without
blocking (live data can change under a PR). When a change makes things better, the gate says so;
run `python kg/ci_check.py --update-baseline` and commit the baseline so it can't slip back.
Proven RED: dropping the #19 `FILTER EXISTS` guard fails it (`NodeHasProvenanceShape fires 34x`).

`.github/CODEOWNERS` makes `kg/` changes need the KG owner's review. The `dev` ruleset makes both binding: every change to `dev` goes through a PR, the `kg` check must pass, and a PR touching `kg/` needs code-owner approval. Repo admins are not exempt.

## Regenerate OWL + boilerplate SHACL from the schema

`bbqs.owl.ttl` and `bbqs.shapes.gen.ttl` are committed. To regenerate after editing the schema
(Windows needs `PYTHONUTF8=1`, and the generators write to stdout — `-o` is ignored):

```bash
kg/.venv/Scripts/python -m pip install linkml
PYTHONUTF8=1 kg/.venv/Scripts/gen-owl   kg/bbqs.linkml.yaml > kg/bbqs.owl.ttl
PYTHONUTF8=1 kg/.venv/Scripts/gen-shacl kg/bbqs.linkml.yaml > kg/bbqs.shapes.gen.ttl
```

`validate()` does not run `bbqs.shapes.gen.ttl` by default (it reads `shapes/*.ttl`). Running it
wouldn't check anything yet either: its paths use the LinkML `slot_uri` IRIs (`schema:*`, `prov:*`)
while the export writes `bbqs:<slot>`, so only 9 of 139 paths match (#422).

## Layout

| Path | What it is |
|---|---|
| `bbqs.linkml.yaml` | **Authoring source of truth.** LinkML vocabulary → generates the OWL TBox and structural SHACL (no JSON-LD context generated yet). |
| `bbqs_kg.py` | `BBQSKnowledgeGraph` — one class wrapping the exporter, validator and reasoner as methods (`export()`, `validate()`, `reason()`, `run()`), taking/returning `pathlib.Path`. `export.py`/`validate.py`/`reason.py`/`main.py` are thin `click` CLIs over it (each also takes `--help`). |
| `export.py` | Exporter CLI: Supabase `resources` spine → instance TTL (`export/bbqs.ttl`, tracked; commit anon exports only). |
| `requirements.txt` / `requirements-generate.txt` | Pinned deps: the harness (export, validate, quality) / plus linkml for the CI drift check. |
| `roundtrip.py` | Round trip: how much of the database a (fresh) export carries, cell by cell → `export/roundtrip.json` (see [Round trip](#round-trip-the-graph-must-be-able-to-rebuild-the-database)). |
| `ci_check.py` | The CI gate: fixtures, export vs `quality_baseline.json`, generated-artifact drift (see [CI gate](#ci-gate)). |
| `quality.py` | Quality evaluation: structure metrics, competency questions, shape coverage, violations → `export/quality.json` + `browser/index.html` (see [Quality evaluation](#quality-evaluation)). |
| `competency_questions.yaml` | The fixed questions the graph must answer, each with its SPARQL and the access level it needs. |
| `competency_questions_extended.yaml` | CQ20-CQ42, the extended set proposed in #441, in the same layout. Not scored by `quality.py` until #441 adopts them; `bench_mcp_server.py` asks them. |
| `browser/template.html` | Graph Inspector page; `quality.py` inlines the report into it to make the self-contained `browser/index.html`. |
| `shapes/consistency.shapes.ttl` | Hand-written SHACL for the cross-field/cross-node **contradiction** checks (what gen-shacl can't produce). |
| `fixtures/contradictions.ttl` | A graph seeded with one violation per consistency shape (the RED case). |
| `fixtures/clean.ttl` | The same graph corrected (the GREEN case). |
| `validate.py` | pyshacl runner CLI: `python kg/validate.py <data.ttl> [shapes…]`. |
| `reason.py` | HermiT (via `owlready2`) DL-reasoner CLI: `python kg/reason.py [data.ttl] [--owl bbqs.owl.ttl]`. |
| `main.py` | Runs the whole pipeline in one call: export, validate, reason, then build the Explorer JSON (`python kg/main.py`). |
| `examples/project-to-triples.md` | Worked example: one project's triples mapped to the spine's identity / type / attachment. |
| `bbqs.owl.ttl` | Generated OWL (`gen-owl`) — the TBox `reason()` checks the export against. |
| `bbqs.shapes.gen.ttl` | Generated boilerplate SHACL (`gen-shacl`) — node/cardinality/pattern shapes. |
| `explorer.py` | Builds `bbqs_explorer.json` for `explorer/index.html`: `BBQSKnowledgeGraph.export_explorer_json()` CLI. |
| `explorer_geocode.py` | Curated `org name -> (lat, lng)` table for the Explorer's globe/map views. |
| `explorer/index.html` | **BBQS Explorer** — single-file D3 v7 app: draggable globe → US map → triple/relationship panel. No build step. |
| `mcp_server.py` | **MCP server**: read-only traversal of an exported graph for AI clients, over stdio or HTTP. No database, no credentials (see [MCP server](#mcp-server-read-the-graph-from-an-ai-client)). |
| `test_mcp_server.py` | Its tests: a hand-built graph with known answers, the competency questions through the server, cross-file guards, and the protocol over stdio and HTTP. |
| `requirements-mcp.txt` | Pinned deps for the server alone: `rdflib` and the MCP SDK. |
| `bench_mcp_server.py` | Benchmark for the server: all 42 competency questions asked over MCP, as SPARQL and without it; the ranking against distance alone; the speed. Writes the results block in the main `README.md`. |

## The three validation layers

1. **Guards (Node, runnable now, zero-dep)** — schema↔DB drift, e.g. `tests/guards/kg-resource-type-parity.test.mjs` ties this schema's `resource_type_enum` to the live Postgres enum. Runs under `npm run test:guards`.
2. **SHACL (pyshacl)** — contradiction checks over an instance graph, in `shapes/`. The generated structural shapes (`bbqs.shapes.gen.ttl`) are not run yet; they don't match the export's IRIs (#422).
3. **OWL reasoning (`reason()`, partial)** — a DL reasoner (HermiT, via `owlready2`; needs a separately installed Java runtime) checks disjoint classes and literals outside their datatype. It cannot catch cardinality or range mismatches between IRIs (no unique-name assumption, open world). Class-level disjointness is a no-op until `bbqs.owl.ttl` gets `owl:disjointWith` axioms (tracked in "Not yet built").

## Consistency-invariant catalog

The convergence target: the invariants a generated graph must satisfy to be *consistent*, each mapped
to the layer that enforces it. Consistency is not completeness — rules like "every project has a
device" are **out of scope** (that's missing data, not a contradiction). Tracked in
[#386](https://github.com/brain-bbqs/bbqs-app/issues/386).

**live** means the shape exists and runs. It does not mean the export contains anything for it to
check; see [shape coverage](#quality-evaluation). Today 7 of 16 shapes have data to check.

| # | Invariant (must hold) | Contradiction it catches | Enforced by | Status |
|---|---|---|---|---|
| 1 | One node has one `resource_type`, matching the table it came from | a `grants` node also typed `investigator`; a `grant` resource with no `grants` row | SHACL (`OneClassPerNodeShape`, `ProjectIsAnAwardShape`) | **live** (1 hit: Psych-DS, a data standard filed as a `grant`) |
| 2 | One IRI per entity; no two typed rows share a `resource_id` | two rows collapse into one node | SHACL / guard | planned |
| 3 | Core classes mutually disjoint (Person/Org/Dataset/Project/Species/Event) | a node typed Person and Product | SHACL (`OneClassPerNodeShape`: the export mints one class per node, so any second class is a clash) | **live** (0 hits) |
| 4 | `ProjectRole.project_role` is a canonical token | role = "Principal Investigator" free text | SHACL `sh:in` | **live** |
| 5 | PI standing comes only from `ProjectRole` (roster), never `consortium_role` | free-text label asserts PI with no roster row (#283) | SHACL SPARQL (`ConsortiumRoleNotAProjectRoleShape`): a machine role token in the label, or a PI label with no PI `ProjectRole` | **live** (0 hits: all 73 people labelled "Principal Investigator (PI)" are PIs on a roster) |
| 6 | Each `ProjectRole` has one `held_by`, one `on_project`, a `role_source`; `held_by` resolves to an Investigator | dangling / source-less role edge | SHACL + OWL functional | **live** (`held_by` → Investigator, at most one holder, one `on_project`; 0 hits on 111 roles) |
| 7 | `studies_species` resolves to a Species node (later: `member_of_group`/`manufacturer`/`award_numbers`) | project studies "Mus musculus" but no such Species node | SHACL SPARQL | **live** (6 real hits; `species_aliases` resolves synonyms, and "no species by design" values like "All Species" route to `study_scope` instead of being flagged) |
| 8 | Working-group tags are canonical (`canonical_working_group`) | non-canonical WG label | SHACL `sh:in` | planned |
| 9 | `mechanism` is consistent with `grant_number` | mechanism `R61` on a `U01...` number | SHACL SPARQL | **live** |
| 10 | Format patterns hold: URLs, ORCID, DOI, grant_number, NCBITaxon IRI | a sentence in a URL field; malformed ORCID | SHACL `sh:pattern` | **partial** (URL fields live, 2 hits: a Job with two links in one field, EMBER's `website` sentence; the rest planned) |
| 11 | Numeric/temporal sanity: amount >= 0, budget_floor <= ceiling, open <= expiration | expiration date before open date | SHACL SPARQL | planned |
| 12 | No two *verified* sources disagree on one field | two trusted `field_provenance` rows conflict | SHACL SPARQL | **live** |
| 13 | Schema `resource_type_enum` == the DB enum | schema/DB drift ("code shipped, migration didn't") | Node guard | **live** |
| 14 | One ORCID → one Investigator node | two Investigator nodes share an `orcid` | SHACL SPARQL | **live** (0 hits on 111 ORCIDs) |
| 15 | One email (primary or secondary) → one Investigator node | same address as one node's `email` and another's `secondary_emails` (the `lyc5332@psu.edu` failure) | SHACL SPARQL | **live** (no targets — `email`/`secondary_emails` are PII, restricted from anon export) |
| 16 | One person has one role per grant (per-edge role is fine across *different* grants) | two `ProjectRole` edges for the same `held_by`+`on_project` pair assert different `project_role` values | SHACL SPARQL | **live** |
| 17 | `Publication.author_orcids` resolves to an Investigator node | an author ORCID with no matching Investigator (graded, not dropped — mirrors #7) | SHACL SPARQL, **warning** | **live**, as a warning (147 hits: author lists name outside co-authors, and only 3 of 126 author ORCIDs are BBQS investigators, 2026-10-21) |
| 18 | A grade-1 (curator) provenance claim is never contradicted by a grade-3 (harvested) claim on the same field | harvested value disagrees with a manually-verified one (field_provenance is append-only) | SHACL SPARQL | **live** (no targets — same RLS gate as #12) |
| 20 | Every award identifier on a Project names the same award as its `grant_number` (`name`, `reporter_project_num`, `nih_link`, `external_url`) | a renumbering updated `grants` but not `resources` | SHACL SPARQL | **live** (2 hits: BARD.CC's `name` and `external_url` still say U24MH136628) |
| 19 | A node cannot exist with zero provenance claims | a node with no `field_provenance` row at all ("unknown" is a value, not an absence) | SHACL SPARQL | **live** (scoped to `Project`; no targets on anon export — same RLS gate as #12) |

## Quality evaluation

Consistency says the graph doesn't contradict itself. It doesn't say the graph is connected, or
that it can answer anything, or that a passing shape had anything to check. `quality.py` measures
those, tracked in [#420](https://github.com/brain-bbqs/bbqs-app/issues/420).

### QA steps

Six checks, run in this order, each answering a different question about the graph. They are
built one at a time, and each gets a board issue under #386 while it's in progress.

| # | Step | Question it answers | How | Status |
|---|---|---|---|---|
| 1 | **Competency questions** | Can the graph answer what it's for? | `competency_questions.yaml`: 19 SPARQL questions pinned to real entities (R34DA059723, House Mouse, WG-Devices). Each is *answered*, *empty* (exporter gap), *n/a* (RLS-gated on anon) or *unmodeled* (schema gap). | **live** (`quality.py`) |
| 2 | **Structural metrics** | Is it one graph or a pile of records? | Nodes and links per class, isolated nodes, connected pieces, dangling links, and the class→predicate→class link matrix. | **live** (`quality.py`) |
| 3 | **Cross-artifact conformance** | Do the export, the OWL and the generated SHACL use the same terms? | Every predicate and class the export emits must be declared in `bbqs.owl.ttl` *and* be a path in `bbqs.shapes.gen.ttl`. Today they disagree: the export and OWL use `bbqs:<slot>`, gen-shacl uses the mapped `slot_uri` (`schema:*`, `prov:*`), so the generated shapes target nothing. | planned (needs one IRI convention) |
| 4 | **Consistency** | Does any part contradict another, and did each check have data? | Node guards (schema↔DB drift), SHACL consistency shapes (the catalog above), the OWL reasoner, plus **shape coverage**: which shapes had inputs to check, so a vacuous pass is visible. | **live**: guards, SHACL, reasoner; shape coverage in `quality.py` |
| 5 | **Accuracy and round trip** | Does the graph say everything the database says, and could the database be rebuilt from it? | `roundtrip.py`: every non-null fact cell of every KG-backed table is checked against its row's node in a fresh export (*carried* or *dropped*), plus a person's review of entity cards against the site (the Inspector's review flags). | **live** (DB half: 71.7% of fact cells carried, anon) |
| 6 | **Coverage** | How much of each record made it in? | Per-class fill rates and external-ID coverage (ORCID, DOI, NCBITaxon). Informational only: it guides enrichment and is not a consistency goal. | planned |

Steps 1, 2 and 4 are one pass:

```bash
kg/.venv/Scripts/python kg/quality.py            # anon export; --access full for a full-access one
```

It writes `export/quality.json` and **`browser/index.html`**, the Graph Inspector. That's one
self-contained file: open it directly. It shows one card per node, faceted by class and by check
(isolated / dangling link / violation), with its facts, links in both directions, violations and
Turtle. Tabs cover the competency questions with their answers, shape coverage, and link structure.
Only build it from an anon export if it will be committed or shared: it embeds every fact in the
graph.

Review flags exist only in the private review copy, an Artifact whose page has a store; opened any
other way the page is read-only. A flag keeps what it pointed at when it was made: a question's
status and row count, or an entity's failing checks, whether it was isolated, and a fingerprint of
its facts and links. The Flags tab compares that with the build on screen and marks each flag
*looks resolved*, *changed, recheck* or *unchanged*. It never clears a flag; removing one is the
reviewer's call.

**Online: https://brain-bbqs.org/kg/inspector/**. `publish.yml` rebuilds it on every deploy of
`main` and daily at 06:17 UTC, from a fresh anon export. If that export fails it falls back to the
committed one, and it never blocks the site deploy. The header stamp shows when it was built, from
which commit and which data; it turns *stale* past 36 hours. The page is unlisted (`noindex`, not
in the sitemap or navigation), but anyone with the link can open it, so it only ever embeds the
anon view. The data is live, but the exporter and quality code come from `main`: a change on `dev`
shows up after `dev` → `main`.

**Latest run (anon export, 2026-10-21, after #421):**

| Measure | Result |
|---|---|
| Structure | 808 nodes, 868 links. **189 isolated (23%)**, in 214 connected pieces (largest 516). Links: `member_of_group` 268, `members` 136, `on_project` 128, `held_by` 126, `produced` 89, `manufacturer` 35, `device_category` 35, `studies_species` 32, `part_of_org` 15, `funded_datasets` 4. On 2026-09-30 it was 453 of 693 isolated (65%), with only the last four kinds. |
| Competency questions | **16 of 19 answered** (was 6), 2 n/a on anon (jobs, provenance), 1 unmodeled (CQ14) |
| Shape coverage | **12 of 16 shapes have data to check** (was 7). The other 4 need what anon can't read: `email` (#15) and provenance (#12, #18, #19). |
| Violations | 11: #7 ×6 (species), #20 ×2 and #1 ×1 (project identity), #10 ×2 (URLs). Plus 147 warnings from #17 (author ORCIDs outside BBQS), which are reported but don't fail the gate. |

On 2026-09-30, ten questions came back empty because the exporter didn't turn anon-readable data
into links. #421 wrote these links:

| CQ | Link written | Anon-readable source |
|---|---|---|
| CQ04, CQ05 who holds a role | `held_by` | `grant_investigators` → `investigators_public` (111 of 111 resolve) |
| CQ06 affiliations | `members` | `investigator_organizations` (95) |
| CQ07 ORCIDs | `orcid` | `investigators_public.orcid` (113) |
| CQ08 working-group members | `member_of_group` | `investigators_public.working_groups` (149) |
| CQ16 software repositories | `repo_url` | `software_tools.repo_url` (18) |
| CQ17 open funding calls | `expiration_date` | `funding_opportunities.expiration_date` (7; 5 still open) |
| CQ03 host institution | `part_of_org` | `projects.organization_id`, but only 3 of 33 set: a data gap as well |
| CQ12 publications per project | `produced` | `project_publications` (2 rows; RePORTER is the live source, see the importer) |
| CQ13 datasets per project | `funded_datasets` | `grant_dandisets` (2) + `dandisets.award_numbers` (3) |

CQ14 (device categories per project) is **unmodeled**: `project_device_usage` has 131 anon rows,
but the schema has no Project → DeviceCategory slot.

### Round trip: the graph must be able to rebuild the database

The target is a **one-to-one, lossless** mapping in both directions: every KG-backed row is one
node, every column a slot, every edge table a set of links, and DB → KG → DB loses nothing.
`python kg/roundtrip.py <fresh export>` measures it cell by cell, with no mapping spec to trust.
Run it on a fresh export: an older file makes every value edited since look dropped.

**2026-11-04, anon, fresh export: 4,505 of 6,283 fact cells carried (71.7%)**; 73.6% on 2026-10-21 and 63% on 2026-09-30. The dip is the 20 dandisets rows added 2026-11-03, a table the graph carries at 23%; no table's own rate fell by more than a point. A
cell the exporter writes as a link (`working_groups` → `member_of_group`, an ORCID → its orcid.org IRI)
counts as carried when the linked node's name, or the IRI's id, equals the value.

| Carried in full | Mostly carried | Largely dropped | Not in the graph at all |
|---|---|---|---|
| `grants`, `grant_investigators`, `organizations`; nearly: `investigators_public` 99%, `software_tools` 99% | `device_manufacturers` 95%, `resources` 80% (`metadata`), `projects` 71%, `device_categories` 67%, `funding_opportunities` 66%, `publications` 62% (authors, citations, keywords) | `announcements` 43%, `species` 41% (order/family/genus), `device_models` 27%, `dandisets` 23% | — |

The join tables (`investigator_organizations`, `project_publications`, `grant_dandisets`) are now
written as links (`members` 95, `produced` 89, `funded_datasets` 2). `roundtrip.py` doesn't count
links yet: their columns are all keys, so they show no fact cells.

It also finds facts stored twice that disagree, which no lossless graph can reconcile: `species.name`
differs from the spine's `resources.name` for 11 of 15 species ("Mouse" vs "House Mouse"), and a few
investigator, dandiset and software names or descriptions differ between their detail table and the
spine. On an anon key this covers the public projection only; RLS-hidden rows and columns need a
full-access run.

## MCP server: read the graph from an AI client

`mcp_server.py` puts the exported graph behind the Model Context Protocol, so Claude (or any MCP
client) can search it, walk it, and ask what is most closely tied to something and how two things
are connected. It loads one Turtle file into
memory and answers from that. Nothing else is involved: no Supabase, no edge function, no sign-in,
no key, and no write path.

It is a different thing from `supabase/functions/bbqs-mcp`, and shares no code with it:

| | `bbqs-mcp` (edge function) | `kg/mcp_server.py` |
|---|---|---|
| Reads | the live database, as the signed-in caller | an exported graph (a snapshot) |
| Writes | yes: member self-service and curator tools | never |
| Sign-in | on demand (OAuth) | none, so it is only given data anyone may read |
| Runs on | Supabase | anywhere Python runs |

### Run it

```bash
pip install -r kg/requirements-mcp.txt
python kg/mcp_server.py --check        # load the graph, print what it holds, exit
python kg/mcp_server.py                # serve over stdio
```

With [uv](https://docs.astral.sh/uv/) there is nothing to install; the script header names its
dependencies:

```bash
uv run kg/mcp_server.py --check
```

Claude Code (give the absolute path to your checkout):

```bash
claude mcp add bbqs-kg -- uv run /path/to/bbqs-app/kg/mcp_server.py
```

Claude Desktop and other clients that take a JSON entry:

```json
{ "mcpServers": { "bbqs-kg": { "command": "uv", "args": ["run", "/path/to/bbqs-app/kg/mcp_server.py"] } } }
```

No checkout is needed: the script names its own dependencies, so uv runs it from GitHub, and it
then reads the export the site publishes, or the one committed to `main`:

```bash
claude mcp add bbqs-kg -- uv run https://raw.githubusercontent.com/brain-bbqs/bbqs-app/main/kg/mcp_server.py
```

### On a public URL

A client that cannot start a local process (a claude.ai connector) needs a URL. GitHub Pages
serves files and cannot run it, so it needs a host that runs a Python process from the repository.
There: install `kg/requirements-mcp.txt`, and start it with

```bash
python kg/mcp_server.py --http --host 0.0.0.0 --no-sparql --allow-host neuromcp.brain-bbqs.org
```

It serves MCP at `/mcp` and a health check at `/health`, on `$PORT` (8000 if the host sets none).
Point a CNAME record for `neuromcp` at the address the host gives, let the host provide HTTPS, and
add `https://neuromcp.brain-bbqs.org/mcp` as a connector. Nothing in this repo deploys it.

There is no sign-in: anyone who can reach it can read whatever the served file holds, which is why
it should only ever serve the public export (see below), and why SPARQL is left off. `--allow-host`
(or `BBQS_KG_ALLOWED_HOSTS`, comma-separated) names the public host names; it keeps the MCP SDK
checking each request to `/mcp` for its `Host` and `Origin`, which stops a page on another site, or
one using DNS rebinding, from calling it through a browser. Without it the SDK checks only when the
server listens on `127.0.0.1` (the default), `localhost` or `::1`, and then a request forwarded by a
proxy or a tunnel for the public name is refused. `/health` is never checked.

### Tools

All seven are reads, and say so to the client (`readOnlyHint`). Every answer carries `snapshot`:
which copy of the graph it came from, that copy's date, and its age in days.

| Tool | What it answers |
|---|---|
| `describe_graph` | The map: node types with counts and how full each property is, link types with their endpoints, and which copy of the graph is being served and how old it is. With a `type`, that type in full: the schema's definition of it and of each property, the values a property takes when they are few, and its links. |
| `search_nodes` | Find nodes by text (names, grant numbers, ORCID, DOI, abstracts, keywords), or list them by type and exact property values. |
| `get_node` | One node in full: every property, and every link grouped by type and direction. |
| `get_neighbors` | Everything within 1 to 4 links of a node, nearest first, each with the link that reached it. Filter by link type, direction and the type of node returned. Does not walk through hubs unless asked. It lists; it does not rank. |
| `find_related` | What is most closely tied to a node, or to several at once (what they have in common), each type of node ranked on its own, up to four links away unless asked. See [how it decides](#how-it-decides-what-is-related). |
| `find_paths` | How two nodes are connected: the shortest chains first, strongest first among them, then longer ones, a page at a time. |
| `sparql_query` | SPARQL `SELECT` / `ASK` over the graph as exported, for counts and aggregates. |

A node can be named by the short id another tool returned, its IRI, or an exact name, grant
number, ORCID, DOI or PMID, so `find_paths("House Mouse", "WG-Devices")` works without a search
first. An ambiguous name comes back as an error listing the candidates, however it was written
(quoted, bracketed, or in a list). An argument a tool does not take is refused, not dropped: a
misspelt `max_hop` would otherwise answer a different question without a word. So is a list that
names nothing, such as `type: "["`.

### What a hop is

Nodes are the typed resources in the export; a link is a triple between two of them. The server
changes two things, so that a hop means something:

- **The roster is folded.** A `ProjectRole` record is one `grant_investigators` row, exported as a
  node between a person and a project. Here it is one `has_role` link from the person to the
  project, carrying the role and where it came from. It stays the only authority for a role on a
  project (#283); `consortium_role` is shown as the free-text label it is.
- **A shared outside identifier is a node.** When two or more nodes carry the same ORCID iD (an
  investigator, and a paper's author list), that iD becomes an `External` node joining them. This
  is the only authorship link the graph has today: 23 shared iDs in the export of 2026-11-05, 3 of
  them a BBQS investigator's. An iD only one node carries stays a property.

Hubs get care in every tool that walks, because "both are in WG-Analytics" is true of over a
hundred people and says little:

- `get_neighbors` reaches a hub (a node with more than 30 links; today, the four working groups)
  but does not walk through it, and lists it in the reply. Two links from a linked investigator is
  a median of 9 nodes this way, against 114 (export of 2026-11-05). Naming the links to follow
  (`edge`) or setting `through_hubs` walks through.
- `find_related` and `find_paths` walk through hubs. A hub passes on little, by the rule in the
  next section, so what lies behind it comes after anything at the same distance that is reached by
  a more exclusive route. What limits them is distance: `max_hops`, 4 by default for `find_related`
  and 6 for `find_paths`, at most 8. Where a working group is all a person has, its members are the list, all
  equal, and the reply says so. `find_paths` also leaves out any chain that goes the long way round
  a direct link. `avoid_edges` drops a link type altogether, in both.

### How it decides what is related

Put plainly: nodes are still listed by how many links away they are, as `get_neighbors` lists
them. What is new is the order among nodes equally far away, and a number that says why.

That order comes from **spreading activation**, the account in psychology of how one idea brings
up another: think of *doctor*, and *nurse* comes to mind faster. It is used here because it is a
theory about a network of concepts, which is what this graph is, and because the rule is short
enough to state and to check.

Activation starts at one node and spreads outward. Three rules, each from the published theory:

1. **It moves one link at a time**, so what is nearer is reached sooner (Collins & Quillian 1969
   found that people take longer the more links lie between two concepts).
2. **A node splits what it received equally among the nodes it is linked to.** This is the usual
   account of the fan effect: the more a concept is linked to, the less each link carries
   (Anderson 1974). A project with 5 neighbours passes on a fifth to each. A working group with
   114 members passes on 1/114.
3. **Amounts that arrive together add up** (Collins & Loftus 1975), so two routes to a node count
   for more than one.

The number that comes out is **strength**. A direct link is 1. Otherwise it is the sum, over the
shortest routes, of 1/neighbours for each node in between, multiplied along the route. There is
nothing to tune. Worked by hand, for a species studied by two projects, one with 5 neighbours and
one with 2:

| Node | How activation gets there | Strength |
|---|---|---|
| The two projects | a direct link each | 1 |
| A person on both projects | 1/5 through the first, 1/2 through the second | 0.7 |
| A person on the first project only | 1/5 | 0.2 |

The person on both ranks first for two reasons the arithmetic keeps apart: two routes instead of
one, and one of them through a project with little else attached to it. On the real graph (export
of 2026-11-05), `find_related("House Mouse", type="Investigator")` puts first the one person on two
House Mouse projects, which have 6 and 9 neighbours (1/6 + 1/9 = 0.28), then the three people on
its smallest project, which has 4 (0.25 each).

Strength is a sum, so it has no ceiling. WG-Analytics and WG-Devices share 57 members and are tied
by 17.8, two links apart. That does not make them closer than a direct link: strength compares
nodes the same distance away, and distance comes first.

How answers are ordered:

- **Each type of node is ranked on its own**: people against people, projects against projects.
  Size goes with type. A working group collects activation from a hundred members and a paper from
  one project, so a single list of both mostly sorts them by size.
- **Nearest first, as in `get_neighbors`, then strongest.** A node three links away never comes
  before one two links away of the same type, however much reaches it. This is the server's rule,
  not the theory's, and it is what keeps the big working groups in their place: ordered by amount
  alone, in one list of everything, a working group the person is not in reaches the first ten for
  172 of 210 people, and nearest first holds that to 15.
- **Four links away, unless asked.** `max_hops` goes up to 8. Per type, `within` counts the
  nodes within reach and `beyond` those farther, which are counted, not listed.
- **Up to 25 per type** when up to three types are named, 10 otherwise: every type at once is
  twenty lists, and at 25 each a reply came to 72 kB.
- **Several starting nodes** ask what they have in common. Only nodes that every one of them
  reaches are returned, each placed by its worst tie (the farthest starting node, and of those the
  weakest), then by its next worst.
- **Ties are said, not hidden.** When a list is cut among equals, `tied` gives how many there are
  and how many were listed, and within a tie the order is by name and means nothing. With several
  starting nodes, two nodes are equals when their worst ties are equal, then their next worst, and
  so on, whichever starting node each tie is to. It is common:
  274 of the 421 default lists of people end that way (export of 2026-11-05), because everyone who
  shares only a working group with someone is tied to them equally.
- **Two nodes are one tie**, however many links record it. A person recorded on a grant twice is
  not twice as close to it.

What a reply carries. A row one link away has `link`, the link itself. A row farther away has
`through`, the strongest route to it (the path `find_paths` lists first), each node on it with
`splits`, the number of neighbours it divided among; where there is more than one route the row
also has `routes`, how many, and `share`, the part of the strength the route shown brings. Where
two nodes are joined by more than one link, `link` is one and `also` the others, each with its own
direction. With several starting nodes a row has `per_start` instead, one tie per starting node.
`find_paths` lists the paths between two nodes shortest first, and
the strongest first among paths of one length (a longer path can be stronger than a shorter one), up
to 25 at a time (`offset` for the next page) and up to 8 links long, each with its own strength;
its `routes` and `strength` are the number and the sum of the shortest ones, which are the figures
`find_related` shows for the pair, `shortest` is their length and `listed` the paths on the page.
A path's `text` draws each link the way it points. A page so deep that finding it would take more
than 50,000 steps is cut short and says `partial`. The two tools are one calculation read two ways, and give the
same answer whichever end the question starts from.

So a nearby answer can be redone by hand from what the reply shows. A far one adds up hundreds of
routes, and `routes` says how many.

For those who know the names: this is a breadth-first search that carries one number, the chance
that a random walker leaving the starting node stands on a given node after as many steps as it is links away, times
the starting node's neighbours. Two links out it is the Resource Allocation index used to predict
missing links (Zhou, Lü & Zhang 2009). The psychology supplies the reasons and the vocabulary. The
arithmetic is ordinary.

What it does not do:

- **Only the first wave is read.** In the full theory activation keeps spreading and echoing until
  it settles, fades a little with every link, and the starting concept divides its own activation
  too. Here a node is read once, when it is first reached, with nothing fading. That buys exact
  fractions and no fading constant or stopping point to choose. It does not buy a better ranking:
  type by type, letting it settle finds hidden ties about as often (64% against 65%).
- **Nearest first is not in the theory**, where what is most active comes to mind first.
- **All link types count the same.** A role on a project and membership of a working group are one
  link each.
- **Strength reads the data as recorded.** A node in the middle with a record missing has fewer
  neighbours and so passes on more: a person with a project and a working group passes on 1/2, and
  1/3 once their organization is recorded too. 87 of the 210 linked investigators have no
  organization recorded (export of 2026-11-05). Read a difference of that size as noise.
- **It is a ranking rule, not a claim about anyone's memory.** Whether activation really spreads
  across several links in people is still argued over (Ratcliff & McKoon 1988).

How it was chosen. Five natural processes were built and run on the real graph: spreading
activation left to settle, an animal foraging from a home base, slime-mould tubes, ant trails, and
a pulse travelling a spider's web. Three reviewers scored them separately and a fourth tried to
break the winner. The web pulse scored highest, with two of the three: it was exact by hand, had
nothing to tune, and never put a far or merely popular node ahead of a near one. Spreading
activation as built came second, because its lists could not be redone by hand and the working
groups rose in them. What is here is the web pulse's arithmetic (a node passing on 1/neighbours
where a junction of threads passes 2/threads, which orders nodes the same way), told as the first
wave of spreading activation, because that is the theory that is about networks of concepts.

Whether it earns its place is measured, and the measure runs with the tests: hide one real tie,
start from one of its ends, ask for nodes of the hidden end's type, and see whether the hidden end
is among the first ten listed after the ones the start is still linked to directly (those come
first in either tool, and are not news). `find_related` has it there 62% of the time (65% when
asked to look up to eight links away). `get_neighbors`, asked for the same type, 45 to 47%. That shows strength is worth
having over distance alone. It does not defend the details of the rule: the hand-worked tests do.

Sources: Quillian (1967), *Behavioral Science* 12, 410-430, where a connection between two
concepts is found where the waves from each meet. Collins & Quillian (1969), *J. Verbal Learning
and Verbal Behavior* 8, 240-247. Anderson (1974), *Cognitive Psychology* 6, 451-474. Collins &
Loftus (1975), *Psychological Review* 82, 407-428. Ratcliff & McKoon (1988), *Psychological
Review* 95, 385-408. Zhou, Lü & Zhang (2009), *European Physical Journal B* 71, 623-630.

A link to a node the export does not contain is shown as an `Unresolved` node rather than dropped,
and a roster record with an end missing is counted in `describe_graph`'s notes (2 in the export of
2026-11-05).

`sparql_query` sees the graph exactly as exported, with neither change. It refuses everything that
is not a read of the loaded graph (updates, `CONSTRUCT`, `DESCRIBE`, `SERVICE`, `FROM`) and stops a
query after 10 seconds. `--no-sparql` leaves the tool out, which is the safer choice for an endpoint
anyone can reach: a stopped query still cost 10 seconds of CPU. Nothing the server tells a client
then mentions SPARQL.

What the view leaves out, it mostly counts in `describe_graph`'s notes rather than dropping in
silence: a roster record with an end missing, or with a person, project, role or role's source
given more than once (no link is made of it); a link to a roster record, and what a record says
besides those, its other types included (records are folded into links, not kept as nodes); a
node's second type (it is listed under the first); and blank nodes, which are not nodes here. Two
things are dropped without a count: a text's language tag, and a value's datatype (the text is
kept). Of all these, the export of 2026-11-05 has two roster records with an end missing, and
datatypes: `xsd:anyURI` on 477 values and `xsd:date` on 27, which no question tells apart.

### Which graph, and how old

`--source` (or `BBQS_KG_SOURCE`) takes a path or a URL. With neither, the server reads the copy
`publish.yml` puts at `https://brain-bbqs.org/kg/bbqs.ttl` whenever its live export succeeds (every
deploy of `main`, and once a day), and falls back to the committed `export/bbqs.ttl`. It re-reads
the source every `--refresh` hours (default 1), and keeps the graph it has when a re-read fails or
comes back with most of the graph missing.

Either way it is a copy, not the database. `describe_graph` reports the source, its date and its
age in days, and says so when it is serving the fallback, so a stale answer is visible. The
committed export is dated by its commit: a checkout stamps every file with the time of the
checkout.

It serves whatever file it is given and has no access control of its own. Give it an anon export
unless every client is entitled to more.

### Benchmark

```bash
python kg/bench_mcp_server.py
```

This starts the server the way a client does (a process, JSON-RPC over stdio) and asks it 42
competency questions: the 19 in `competency_questions.yaml` that the graph is scored on, and the 23
in `competency_questions_extended.yaml` that #441 proposes adding. Each is asked twice: as SPARQL
through `sparql_query`, and without SPARQL through `search_nodes`, `get_node` and `find_related`.
Both must return the rows the export gives when it is queried directly, and the command fails if
either does not. Questions that return nothing are compared too, and must return nothing both ways. It then measures the ranking
(the hidden-tie measure above, with the tools' real output) and the speed of each tool. The results
are in the main [`README.md`](../README.md#benchmark); `--update README.md` rewrites them there.
`--show CQ04` prints one question's rows each way, `--only questions` leaves the measurements out,
and `--source` takes another export (with `--access full` if it is a full one, so that a question
with no rows there is not reported as needing the full export). The reference is the file queried
directly by rdflib, with each cell written out by the benchmark's own rules, so a fault in how the
server writes a value would show as a difference. Four things are evened out because they are not
part of an answer: numbers, whole or not, are compared to 12 significant digits (a sum's last digits
depend on the order it is taken in); an IRI and the same text compare equal, however each is
written (`<urn:x>`, `bbqs:Foo`), because the graph tools give an IRI that is not a node as text;
blank nodes compare equal, because each reading of a file labels them afresh; and the order of the
parts of a cell that joins several. CQ17 and CQ39 compare dates as ISO text, which is what an
`xsd:date` is. A question with rows counts as answered even if it uses a term the schema does not
declare; one the export queried directly refuses (text where a sum needs a number, say) is shown
apart, as could not be asked, and fails the run.

On the public export 13 of the 42 return no rows, for three reasons. Seven ask about jobs or
provenance, which only a full-access export carries (CQ18, CQ19, CQ30, CQ35, CQ36, CQ37, CQ40). One
asks for a link the schema does not have (CQ14). Five are understood and have nothing to list
today: nobody holds two kinds of role (CQ24), every free-text species is also resolved (CQ27), no
model has a benchmark linked (CQ31), no funding call expires in CQ39's window, and every working
group has a member with a role (CQ42). A question of the form "which X has no Y" (CQ21, CQ27,
CQ30, CQ33, CQ38, CQ42) lists every X with no Y *recorded*, which in a graph still being linked is
not the same as having none.

A walk without SPARQL sees the graph as the server shows it, which differs from the file where the
view leaves something out (above): a roster record it could not fold or a link to one, a second
type, a blank node, a language tag or datatype. SPARQL reads the file as it is, so a question that
can tell is reported as different, which is right. The export of 2026-11-05 has two roster records with an end missing,
and no question can tell. A question that cannot be walked in full (a node with more than 500 links
of one kind, more than `get_node` lists at once) fails on its own and says why; the others are
still asked.

### Tests

```bash
pip install -r kg/requirements.txt -r kg/requirements-mcp.txt
python kg/test_mcp_server.py
```

The KG gate runs them on every PR that touches `kg/`. They cover a hand-built graph whose answers
were worked out by hand, strengths included; every competency question the baseline says is
answered, asked through the server; the walking tools against SPARQL on the committed export; and
the protocol itself, by a raw JSON-RPC client against a real process over stdio and over HTTP. The
ranking has checks of its own: the code gives exactly what spreading with nothing left out
delivers first (a second, slower version of the process, written without the shortcuts); the paths
between two nodes add up to the strength shown for them; the worked example in the tool
descriptions is built and run, so what a client is told is what the server does; replies stay a
size a client can take; and the hidden-tie measure above. Every argument of every tool is shown to
reach the graph: each is set away from its default, the answer compared with the method called
directly, and shown to change when that argument alone is reset. The benchmark's 42 questions are
run here too: on the committed export; on a graph in miniature in which every one of them has
rows, the number of rows worked out by hand; and on one built from the shapes an export could take
and today's does not (ids nothing describes, a property given twice or not at all, the same two
nodes linked twice, two things with one name, amounts with cents), each of which once led a walk
astray. The benchmark's own measure is run on a graph whose every case was worked out by hand,
and its command line end to end. Three guards hold across files: every
schema term the server or its descriptions name is declared in `bbqs.owl.ttl`, the pins in the
script header match `requirements*.txt`, and no call that writes to a graph appears outside the
one that loads it. The suite was shown able to fail: the server was broken 128 ways in a
scratch copy, one at a time (100 of them in the ranking), and every break turned it red. The
benchmark's walks were broken 62 ways in the same way, and its tests caught every one.

## Not yet built

- **Phase 5 cleanup**: remove the orphan `resources` rows the backfill left (~14 `investigator` + 1 `grant` that point at no table row); add an insert trigger so new rows get a `resource_id` automatically; and once `types.ts` is regenerated, promote the 6 backfilled `resource_type` values from PROPOSED → shipped in the LinkML (the parity guard will flag it).
- **Full-access export**: run with a key that can read investigators / field_provenance / working-group detail; map `field_provenance` → PROV (needed by shapes 5 and 12).
- **`owl:disjointWith` axioms**: no longer needed for #1/#3, which SHACL now enforces (`OneClassPerNodeShape`). #411's axioms, the distinct-node declaration and its reasoner failing cases are the starting point if the reasoner gets a real job, e.g. once the Marr layer adds inference chains.
- **Data fixes in Supabase, not exporter changes:** the two non-URI values in URI fields (`Job.external_url` with two links; EMBER's `Project.website` holding a sentence — see above), and one investigator whose `name` has an email address appended, which puts the address in the public export.
