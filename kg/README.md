# BBQS Knowledge Graph

RDF/OWL knowledge graph of the BBQS consortium. **Current goal: generate a *consistent* graph and
validate that no part contradicts another** — not enrichment. Consistency ≠ completeness; missing
per-project detail is out of scope for now.

## Layout

| Path | What it is |
|---|---|
| `bbqs.linkml.yaml` | **Authoring source of truth.** LinkML vocabulary → generates OWL + SHACL + JSON-LD. |
| `shapes/consistency.shapes.ttl` | Hand-written SHACL for the cross-field/cross-node **contradiction** checks (what gen-shacl can't produce). |
| `fixtures/contradictions.ttl` | A graph seeded with one violation per consistency shape (the RED case). |
| `fixtures/clean.ttl` | The same graph corrected (the GREEN case). |
| `validate.py` | pyshacl runner: `python kg/validate.py <data.ttl> [shapes…]`. |

## The three validation layers

1. **Guards (Node, runnable now, zero-dep)** — schema↔DB drift, e.g. `tests/guards/kg-resource-type-parity.test.mjs` ties this schema's `resource_type_enum` to the live Postgres enum. Runs under `npm run test:guards`.
2. **SHACL (pyshacl)** — structural + contradiction checks over an instance graph. The interesting shapes live in `shapes/`; the boilerplate node/cardinality/pattern shapes come from `gen-shacl` (see below).
3. **OWL reasoning (deferred)** — pure-logic contradictions (disjoint classes, functional properties) via a DL reasoner (robot/HermiT). Needs Java; added after the SHACL layer is green.

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

## Not yet built

- **Exporter**: Supabase `resources` spine → instance TTL (`resources.id` = IRI, `resource_type` = rdf:type; joins `grants ⋈ projects`; promotes `study_species[]` / `working_groups[]`; maps `field_provenance` → PROV).
- **Backfill migration**: add `resource_type` values + `resource_id` for species / devices / manufacturers / working groups / funding / events.
- **OWL reasoning layer** (see above).
