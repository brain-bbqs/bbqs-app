# KG-ready CSV schema — People & Publications

Two CSV files exported by the `kg-csv-export` edge function feed the downstream
TriG lifter. Every column maps directly to one triple (or one blank node) in
the named-graph layout below, so the lifter never has to guess.

Named graphs (from the reference TriG):

- `graph:core` — canonical entities (`schema:Person`, `schema:ScholarlyArticle`,
  `schema:Organization`).
- `graph:claims` — reified `ex:Claim` nodes carrying L1 evidence + L2 curation
  state.
- `graph:provenance` — `prov:Activity`, `prov:Agent`, `ex:Evidence`.
- `graph:derived` — materialised convenience triples (e.g. `person schema:author pub`).
- `graph:access` — L3 access policies and security labels.

L1 = evidence (source, raw value). L2 = claim status + confidence.
L3 = security label + access policy. Rows always ship with L3 defaults;
L1/L2 are filled where trivially derivable and left blank otherwise for
curator promotion.

## `people.csv`

Endpoint: `GET /functions/v1/kg-csv-export?entity=people` (admin JWT required).

| Column | Source (`public.investigators`) | TriG target |
|---|---|---|
| `person_id` | `id` (UUID) | subject IRI `person:{id}` in `graph:core` |
| `name` | `name` | `schema:name` |
| `orcid` | `orcid` | `schema:identifier` blank node (`propertyID=ORCID`) |
| `email_primary` | `email` | `schema:email` (label `Internal`) |
| `institution_name` | `institution` | `schema:affiliation` → `schema:Organization/schema:name` |
| `role` | `role` | `ex:consortiumRole` |
| `working_groups` | `working_groups[]` joined by `;` | one `ex:memberOf` per group |
| `scholar_id` | `scholar_id` | `schema:identifier` (`propertyID=GoogleScholar`) |
| `reporter_profile_id` | `reporter_profile_id` | `schema:identifier` (`propertyID=NIH_RePORTER`) |
| `profile_url` | `profile_url` | `schema:url` |
| `tenant` | constant `consortium-alpha` | `ex:tenant` |
| `security_label` | default `Internal` | `ex:securityLabel` (L3) |
| `access_policy` | default `policy-consortium-read` | `ex:accessPolicy` (L3) |
| `claim_status` | blank | `ex:claimStatus` on the identity claim (L2) |
| `confidence` | blank | `ex:confidence` (L2) |
| `evidence_source` | blank | `ex:hasEvidence → dct:source` (L1) |
| `asserted_in` | blank | `ex:assertedIn` (L1) |
| `generated_at` | `updated_at` | `prov:generatedAtTime` |

## `publications.csv`

Endpoint: `GET /functions/v1/kg-csv-export?entity=publications`.

| Column | Source (`public.publications`) | TriG target |
|---|---|---|
| `publication_id` | `id` | subject IRI `pub:{id}` in `graph:core` |
| `doi` | `doi` | `schema:identifier` (`propertyID=DOI`) |
| `pmid` | `pmid` | `schema:identifier` (`propertyID=PMID`) |
| `title` | `title` | `dct:title` |
| `journal` | `journal` | `schema:isPartOf/schema:name` |
| `year` | `year` | `schema:datePublished` |
| `authors_raw` | `authors` | evidence-only — feeds `ex:Evidence.rawValue`, not `schema:author` |
| `author_orcids` | `author_orcids` (JSON) → `;`-joined ORCIDs | fan out to one `schema:author → person:{orcid}` per ORCID in `graph:derived`, plus one `claim:authorship-{pub}-{orcid}` in `graph:claims` |
| `citations` | `citations` | `ex:citationCount` |
| `rcr` | `rcr` | `ex:relativeCitationRatio` |
| `keywords` | `keywords[]` joined by `;` | `schema:keywords` |
| `url` | `pubmed_link` or `https://doi.org/{doi}` | `schema:url` |
| `tenant` | constant `consortium-alpha` | `ex:tenant` |
| `security_label` | default `Public` | `ex:securityLabel` (L3) |
| `access_policy` | default `policy-public-read` | `ex:accessPolicy` (L3) |
| `claim_status` | `Verified` when both DOI and ≥1 ORCID present, else blank | `ex:claimStatus` on each authorship claim (L2) |
| `confidence` | blank | `ex:confidence` (L2) |
| `evidence_source` | DOI URL when present | `ex:hasEvidence → dct:source` on each claim (L1) |
| `ingestion_agent` | constant `crossref-ingestion-agent` | `prov:wasAttributedTo` |
| `generated_at` | `updated_at` | `prov:generatedAtTime` |

## Lifter conventions

- Multi-value cells use `;` as the separator. Never commas — those live in
  quoted CSV fields.
- Empty string means "not asserted". The lifter must emit no triple for that
  column rather than emitting a blank literal.
- IRIs are minted by prefixing the CSV id: `person:{person_id}`,
  `pub:{publication_id}`. Ids are stable UUIDs from the source tables.
- `graph:access` policies (`policy-consortium-read`, `policy-public-read`,
  `policy-curator-read`) are constants managed in the lifter, not the CSV.

## Where the export lives

- **UI:** Settings → Data & Configuration → *Knowledge graph exports*
  (admin-only, see `src/components/profile/DataAndConfigCard.tsx`).
- **Server:** `supabase/functions/kg-csv-export/index.ts` — admin JWT via
  `requireAdmin`, service-role read on `investigators` / `publications`,
  streams `text/csv`.

## Open questions (unresolved from the plan)

1. Authorship as fan-out inside `publications.csv` (current default) vs. a
   third `authorships.csv`.
2. Whether people scope should narrow to consortium PIs (`grant_investigators`
   roster) or stay as every `investigators` row.
3. Whether the `tenant` constant should be the real BBQS identifier used
   elsewhere in the app instead of `consortium-alpha` from the reference TriG.
