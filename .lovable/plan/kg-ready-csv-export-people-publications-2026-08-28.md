# KG-Ready CSV Export: People + Publications

Goal: produce two CSV files for the whole consortium — `people.csv` and `publications.csv` — whose columns line up 1:1 with the TriG schema you shared, so a downstream job can lift them into named graphs (`core`, `claims`, `provenance`, `derived`, `access`) without renaming anything.

## Deliverables

1. Two CSVs, downloadable from **Settings → Data & Config** and also emitted by an edge function for the automation loop:
   - `people.csv` — one row per investigator in `investigators`.
   - `publications.csv` — one row per row in `publications`.
2. A short header doc (`docs/kg-csv-schema.md`) mapping every CSV column to its TriG triple (subject / predicate / object / graph).
3. No schema migration in this pass. L1–L3 (claim status, evidence, access policy) are emitted as **blank columns with fixed defaults** so the file shape is final now and we fill values later.

## `people.csv` columns

Mirrors `graph:core` person block + the L1–L3 slots we don't know yet.

| Column | Source | TriG target |
|---|---|---|
| `person_id` | `investigators.id` (UUID) | `person:{id}` IRI |
| `name` | `investigators.name` | `schema:name` |
| `orcid` | `investigators.orcid` | `schema:identifier` (PropertyValue, propertyID=ORCID) |
| `email_primary` | `investigators.email` | `schema:email` (Internal) |
| `institution_name` | `investigators.institution` | `schema:affiliation` → `schema:Organization/schema:name` |
| `role` | `investigators.role` | `ex:consortiumRole` |
| `working_groups` | `investigators.working_groups` joined by `;` | `ex:memberOf` (repeatable) |
| `scholar_id` | `investigators.scholar_id` | `schema:identifier` |
| `reporter_profile_id` | `investigators.reporter_profile_id` | `schema:identifier` (NIH RePORTER) |
| `profile_url` | `investigators.profile_url` | `schema:url` |
| `tenant` | constant `consortium-alpha` | `ex:tenant` |
| `security_label` | default `Internal` | `ex:securityLabel` (L3) |
| `access_policy` | default `policy-consortium-read` | `ex:accessPolicy` (L3) |
| `claim_status` | blank | `ex:claimStatus` (L2, filled by curation) |
| `confidence` | blank | `ex:confidence` (L2) |
| `evidence_source` | blank | `ex:hasEvidence → dct:source` (L1) |
| `asserted_in` | blank | `ex:assertedIn` (L1) |
| `generated_at` | `investigators.updated_at` | `prov:generatedAtTime` |

## `publications.csv` columns

| Column | Source | TriG target |
|---|---|---|
| `publication_id` | `publications.id` | `pub:{id}` IRI |
| `doi` | `publications.doi` | `schema:identifier` |
| `pmid` | `publications.pmid` | `schema:identifier` |
| `title` | `publications.title` | `dct:title` |
| `journal` | `publications.journal` | `schema:isPartOf/schema:name` |
| `year` | `publications.year` | `schema:datePublished` |
| `authors_raw` | `publications.authors` | (for evidence, not `schema:author`) |
| `author_orcids` | `publications.author_orcids` JSON → `;`-joined | one `schema:author → person:{orcid-resolved}` per ORCID |
| `citations` | `publications.citations` | `ex:citationCount` |
| `rcr` | `publications.rcr` | `ex:relativeCitationRatio` |
| `keywords` | `publications.keywords` joined by `;` | `schema:keywords` |
| `url` | `publications.pubmed_link` or DOI | `schema:url` |
| `tenant` | constant `consortium-alpha` | `ex:tenant` |
| `security_label` | default `Public` | `ex:securityLabel` (L3) |
| `access_policy` | default `policy-public-read` | `ex:accessPolicy` (L3) |
| `claim_status` | default `Verified` when DOI+ORCID both present, else blank | `ex:claimStatus` (L2) |
| `confidence` | blank | `ex:confidence` (L2) |
| `evidence_source` | DOI URL when present | `ex:hasEvidence → dct:source` (L1) |
| `ingestion_agent` | constant `crossref-ingestion-agent` | `prov:wasAttributedTo` |
| `generated_at` | `publications.updated_at` | `prov:generatedAtTime` |

## Authorship linking (implicit third file, optional)

Rather than a separate `authorships.csv`, we encode authorship *inside* `publications.csv` via `author_orcids` (semicolon-joined ORCID list). The lifter fans this out into one `claim:authorship-{pub}-{orcid}` per pair, matching the `graph:claims` block. If you'd rather have a flat `authorships.csv`, say the word.

## L1–L3 defaults (the "we don't know yet" layers)

- **L1 evidence:** filled where trivially derivable (DOI URL for pubs). Blank for people until curator adds a source.
- **L2 claim status/confidence:** blank by default; the Suggest-a-Feature / curation loop is where a curator promotes rows.
- **L3 security/access:** hardcoded defaults per row type — people default `Internal / policy-consortium-read`; publications default `Public / policy-public-read`. Curators can override in the DB later.

## Where the export lives

- **UI:** `src/components/profile/DataAndConfigCard.tsx` already exports the user's config as CSV/JSON. Add two new buttons: **Export People (KG-ready CSV)** and **Export Publications (KG-ready CSV)**. Admin-only visibility.
- **Server:** new edge function `kg-csv-export` with `?entity=people|publications` returning `text/csv`. Uses service-role read of `investigators` / `publications`, applies the column mapping above, streams the file. CORS locked to app origins per `_shared/security.ts`.
- **Docs:** `docs/kg-csv-schema.md` — table of columns + TriG mapping (copy from this plan) so Brian and Claude can write the lifter without re-reading the app.

## Out of scope for this pass

- No RDF/TriG generation in-app. CSV out; the lifter is a separate script.
- No new tables. Blank L1/L2 columns are placeholders, not stored fields.
- No re-normalisation of `authors` free-text — that's a curation-loop job.

## Open questions

1. Authorship as fan-out inside `publications.csv` (proposed), or a third `authorships.csv`?
2. Should the export scope to *consortium PIs only* (matches `grant_investigators` roster) or *every row in `investigators`* (includes trainees + staff)?
3. Default tenant string — `consortium-alpha` from your example, or the real BBQS identifier we already use elsewhere?
