# BBQS Knowledge Graph

RDF/OWL knowledge graph of the BBQS consortium. **Current goal: generate a *consistent* graph and
validate that no part contradicts another** — not enrichment. Consistency ≠ completeness; missing
per-project detail is out of scope for now.

## Build phases

**Where we are:** Phase 5 cleanup is outstanding. The first quality pass landed (#420) and showed
the graph is mostly unlinked. Next: export the edge tables (#421) and one IRI convention (#422).
This table is the running status of the whole effort, updated as each phase lands.

| # | Phase | Step | Status |
|---|---|---|---|
| 0 | Foundations & decisions — consistency-not-enrichment; LinkML master = source of truth; `resources` spine = node backbone; SHACL-first then OWL; Project=Grant; ontology alignments chosen | — | **done** |
| 1 | Schema authored — `bbqs.linkml.yaml`, DB-grounded, 31 classes, Marr stubbed | — | **done** (v0.3 — keep-list from #397: schema hygiene + `Algorithm`; `title`/DANDI kept, device/SOSA deferred) |
| 2 | Consistency invariants — the 19-row catalogue below; RED/GREEN fixtures; schema↔DB drift guard | — | **done** (12 shapes + 1 guard; on the anon export only 3 shapes have data to check — see [QA](#quality-evaluation)) |
| 3 | Exporter — `resources` spine → instance TTL; grants⋈projects; ProjectRole; `species_aliases` resolver; `field_provenance`→PROV | **A** | **done**, with a gap: 3,045 triples, 6 dangling species, but only four kinds of link are written, so 65% of nodes are isolated (#421) |
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
| `ci_check.py` | The CI gate: fixtures, export vs `quality_baseline.json`, generated-artifact drift (see [CI gate](#ci-gate)). |
| `quality.py` | Quality evaluation: structure metrics, competency questions, shape coverage, violations → `export/quality.json` + `browser/index.html` (see [Quality evaluation](#quality-evaluation)). |
| `competency_questions.yaml` | The fixed questions the graph must answer, each with its SPARQL and the access level it needs. |
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
check; see [shape coverage](#quality-evaluation). Today only #4, #7 and #9 have data to check.

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
| 5 | **Accuracy against the source** | Does the graph say what the database says? | Count reconciliation (nodes per class vs rows per table, e.g. 34 Projects vs 33 grants), plus a sampled gold standard: a person checks N random entity cards against the site. | planned |
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

**Online: https://brain-bbqs.org/kg/inspector/**. `publish.yml` rebuilds it on every deploy of
`main` and daily at 06:17 UTC, from a fresh anon export. If that export fails it falls back to the
committed one, and it never blocks the site deploy. The header stamp shows when it was built, from
which commit and which data; it turns *stale* past 36 hours. The page is unlisted (`noindex`, not
in the sitemap or navigation), but anyone with the link can open it, so it only ever embeds the
anon view. The data is live, but the exporter and quality code come from `main`: a change on `dev`
shows up after `dev` → `main`.

**Latest run (anon export, 2026-09-29):**

| Measure | Result |
|---|---|
| Structure | 693 nodes, 205 links. **453 isolated (65%)**, in 491 connected pieces. Only four kinds of link exist: `on_project` 111, `manufacturer` 35, `device_category` 35, `studies_species` 24. |
| Competency questions | **6 of 19 answered**, 10 empty, 2 n/a on anon (jobs, provenance), 1 unmodeled |
| Shape coverage | **3 of 12 shapes have data to check** (#4, #7, #9). The other 9 pass vacuously: their inputs (`held_by`, `orcid`, `email`, `consortium_role`, provenance) aren't in the export. |
| Violations | 6, all #7 |

Each empty question traces to data the exporter doesn't turn into links. Almost all of it is
anon-readable. In particular `held_by` resolves for all 111 roles through `investigators_public`,
so its absence is an exporter gap, not RLS.

| CQ | Missing link | Anon-readable source |
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

## Not yet built

- **Phase 5 cleanup**: remove the orphan `resources` rows the backfill left (~14 `investigator` + 1 `grant` that point at no table row); add an insert trigger so new rows get a `resource_id` automatically; and once `types.ts` is regenerated, promote the 6 backfilled `resource_type` values from PROPOSED → shipped in the LinkML (the parity guard will flag it).
- **Full-access export**: run with a key that can read investigators / field_provenance / working-group detail; map `field_provenance` → PROV (needed by shapes 5 and 12).
- **`owl:disjointWith` axioms**: `gen-owl` doesn't emit them from the LinkML `disjoint_with` slot yet, so `reason()` has no class-level contradictions to catch today — only the datatype ones (see above). Fixing this is what makes invariant #3 in the catalog above (and half of #1) go from planned to live.
- **Data fixes in Supabase, not exporter changes:** the two non-URI values in URI fields (`Job.external_url` with two links; EMBER's `Project.website` holding a sentence — see above), and one investigator whose `name` has an email address appended, which puts the address in the public export.
