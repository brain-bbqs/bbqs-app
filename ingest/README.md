# Data ingestion

Unstructured material keeps arriving: workshop notes, slide decks, transcripts, emails, form
answers. This directory and its tables turn that material into structured rows in Supabase, so
the knowledge graph never reads a file. Every value can be traced back to the document it came
from and the person or model that extracted it.

```
 raw document ──▶ ingestion_sources          one row per document (what, where, when)
      │
  extract (person or LLM), meeting ingest/kinds/<kind>.schema.json
      ▼
 ingestion_records                           one row per record: payload, review_flags, status
      │                                       (curator-only, since payloads quote the source)
  review: clear flags, fix payloads, reject
      ▼
 promote_ingestion_record()  ──▶  domain tables (the system of record)
                                    sensor_deployments + _devices + _properties (+ _presenters, curator-only)
      ▼
 kg/bbqs_kg.py export()  ──▶  kg/export/bbqs.ttl  (SOSA layer: kg/sosa/README.md)
```

**The constitution holds at every stage:**
- **Principle III, live state.** The graph is built from the domain tables, never from a file
  here.
- **Principle X, provenance.** Every table has the audit trigger and every seed calls
  `set_actor`. The provenance recorder grades each promoted cell at the record's source class:
  `curator_fill` for a person, `llm_extract` for a model.
- **Principle XI, no static copies.** The files under `sources/` are what was ingested, kept as the
  intake record. Nothing renders from them.

## Layout

| Path | What |
|---|---|
| `kinds/<kind>.schema.json` | The contract for one record kind. An extractor, human or LLM, must emit a payload that validates against it. `promote_ingestion_record()` knows how to write each kind. Today there is one kind: `sensor_deployment`. |
| `sources/<source>/source.json` | Metadata for one ingested document: slug, kind, title, `record_kind`, `extracted_by` (`human:…` or `llm:<model>`) and `source_class`. |
| `sources/<source>/records.csv` | The extracted records, one row per record. `source_locator` says where in the document each one came from. Lists are `;`-separated. |
| `vocab/sensor_properties.csv` | The `observable_properties` vocabulary: 52 observable keys and 1 actuatable key, each aligned to a device category. |
| `to_sql.py` | Validates the records against the schema and the database's cross-field rules. Computes review flags, then writes the seed migration (vocabulary, source, records, then promotion). `--check` fails CI when a record is invalid or the committed seed is stale. |

The tables and the promote function are created in
`supabase/migrations/20261006120000_data_ingestion.sql`. Each source's seed is generated, for
example `20261006120100_ingest_workshop_appendix_a.sql`. Migrations are applied by hand in the SQL
editor: schema first, then seed.

## Review flags and status

`to_sql.py` sets flags that a curator should look at:

| Flag | Raised when |
|---|---|
| `grant_ambiguous` | Several grants fit the award as named |
| `grant_unresolved` | No grant fits |
| `grant_title` | The grant was matched by title only |
| `no_presenter` | Nobody spoke to the device |
| `verify_note` | The source says something needs checking |
| `model_inferred`, `model_candidates` | The model was guessed, or several models were named |

Promotion adds one more flag, `device_not_in_catalogue:<name>`, when a named model has no
`device_models` row.

A record with no flags from a human extractor starts as `accepted`; everything else starts as
`pending_review`, and **any LLM extraction starts as `pending_review` whatever its flags**. Flagged
records still promote, because the flags travel into the graph (`grant_match`, `verify_note`) and
the SOSA shapes keep them visible. `rejected` records never promote.

## Correcting a record

1. Edit the payload: in `records.csv` and regenerate, or directly in `ingestion_records`.
2. Run `SELECT promote_ingestion_record('<id>')` again. Promotion is idempotent: it updates the
   deployment in place and replaces its links.
3. The provenance guard on `sensor_deployments` still applies. A machine re-extraction cannot
   overwrite a cell a curator has verified.

## Adding the next source

1. Create `sources/<yyyy-what>/` with a `source.json` and `records.csv` for an existing kind, then
   run `python ingest/to_sql.py`. Today the script reads the one source; generalising it to every
   directory is the first step of the next ingest.
2. For a new kind:
   - write `kinds/<kind>.schema.json`
   - add the kind to the `record_kind` CHECK
   - add a branch in `promote_ingestion_record()`
   - add the domain table(s)
   - add the exporter section

## Not built yet

- **LLM extraction.** An edge function `ingest-document` that takes a raw document, registers it in
  `ingestion_sources` (raw file in Storage), and asks a model for payloads matching the kind's
  schema. It would write them as `pending_review` with `extracted_by = 'llm:<model>'` and
  `source_class = 'llm_extract'`. `parse-onboard` is the pattern to copy: the LLM proposes and a
  person decides. Choose the provider first: `parse-onboard` uses the Lovable AI gateway, which is
  being decommissioned, and `bbqs-agent` uses OpenRouter.
- **A review screen.** Today this is curator SQL: `ingestion_records WHERE status = 'pending_review'`.
  A screen in the admin console, plus an agent tool on the `confirm_species_candidate` pattern, is
  phase S5 in `kg/sosa/README.md`.
