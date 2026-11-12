# BBQS — Brain Behavior Quantification and Synchronization

The **BBQS** program is an NIH-funded basic research initiative to develop new tools and approaches for a more comprehensive, mechanistic understanding of the neural basis of behavior. This repository powers the [BBQS consortium website](https://brain-bbqs.org), serving as the central hub for the community.

## About the Program

BBQS brings together a cross-disciplinary consortium of researchers to:

- **Measure behavior** — Develop tools for simultaneous, multimodal measurement of behavior within complex, dynamic physical and social environments, synchronized with neural recordings.
- **Model brain-behavior relationships** — Create novel computational models that capture dynamic behavior-environment relationships across multiple timescales, integrated with correlated neural activity.
- **Share data and tools** — Establish shared data archives (EMBER), ontologies, standards, and ethical frameworks that transform how mechanistic brain-behavioral research is conducted.

## Status

| | Pipeline | What it does | Status |
|:---:|---|---|:---|
| ✅ | Sandbox QA | Clones prod into the sandbox project, deploys the sandbox site, runs smoke tests | [![Sandbox QA](https://github.com/brain-bbqs/bbqs-app/actions/workflows/sandbox-qa.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-app/actions/workflows/sandbox-qa.yml) |
| ✅ | Backup | Nightly `pg_dump` of the production database to a retained artifact | [![Database Backup](https://github.com/brain-bbqs/bbqs-app/actions/workflows/db-backup.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-app/actions/workflows/db-backup.yml) |
| ✅ | Guards | Cross-layer invariant tests on every PR (CORS parity, roles, schema) | [![Guards](https://github.com/brain-bbqs/bbqs-app/actions/workflows/guards.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-app/actions/workflows/guards.yml) |
| ✅ | Deploy | Builds and publishes the production site to GitHub Pages | [![Deploy](https://github.com/brain-bbqs/bbqs-app/actions/workflows/publish.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-app/actions/workflows/publish.yml) |

Green badge = live, red = dead.

## What This Site Provides

| Section | Description |
|---|---|
| **People & Working Groups** | Directory of consortium investigators and collaborative working groups |
| **Projects & Grants** | Funded research projects with metadata, species, and publication links |
| **Publications** | Consortium publication catalog with citation metrics |
| **Resources** | Curated database of software tools, datasets, benchmarks, and protocols |
| **EMBER Assistant** | AI-powered metadata editing tool for DANDI archives |
| **Data Sharing Policy** | Working draft of the consortium-wide data sharing policy |
| **Tutorials** | Learning materials for consortium tools and workflows |
| **Job Board & Calendar** | Community job postings and upcoming events |

## Knowledge graph over MCP

The consortium's public knowledge graph (projects, people, working groups, organizations, species, publications) can be read by Claude and other AI clients through a small read-only [MCP](https://modelcontextprotocol.io) server, [`kg/mcp_server.py`](kg/mcp_server.py). It loads the exported graph into memory and answers from that: no database, no sign-in, no write path. What is related to what is ranked by spreading activation, the account in psychology of how one idea brings up another; [`kg/README.md`](kg/README.md#how-it-decides-what-is-related) states the rule and works an example by hand.

Check that it loads, then ask it the consortium's own questions:

```bash
uv run kg/mcp_server.py --check
```

```bash
uv run kg/bench_mcp_server.py
```

The second command starts the server the way a client does and asks it 42 competency questions: the [19 the graph is scored on](kg/competency_questions.yaml) and the [23 proposed in #441](kg/competency_questions_extended.yaml). Each is asked twice, once as SPARQL and once without SPARQL through the graph tools, and both are checked against the export queried directly. It then measures the ranking and the speed. `--show CQ04` prints one question's rows; `--only questions` skips the measurements. Without [uv](https://docs.astral.sh/uv/), run `pip install -r kg/requirements.txt -r kg/requirements-mcp.txt` and use `python` in place of `uv run`.

To talk to it from Claude Code (give the full path to your checkout):

```bash
claude mcp add bbqs-kg -- uv run /path/to/bbqs-app/kg/mcp_server.py
```

Or, with no checkout at all, straight from GitHub:

```bash
claude mcp add bbqs-kg -- uv run https://raw.githubusercontent.com/brain-bbqs/bbqs-app/main/kg/mcp_server.py
```

To serve it on a public URL for a claude.ai connector, see [On a public URL](kg/README.md#on-a-public-url).

### Benchmark

<!-- kg-mcp-benchmark:start -->
Graph: 703 nodes, 791 links, export of 2026-11-05. Server 0.2.0.

| | Result |
|---|---|
| Competency questions that return rows on this export | **29 of 42**: 16 of the 19 the KG is scored on, 13 of the 23 proposed in #441 |
| Those 29, asked as SPARQL through the server: same rows as the export queried directly | **29 of 29** |
| Those 29, asked without SPARQL through the graph tools: same rows again | **29 of 29** |
| The other 13 (7 need the full export, 5 find none in this export, 1 not modelled yet): no rows either way | **13 of 13** |
| Hide a real tie: the hidden end is among the first ten `find_related` lists after the start's direct ties (1,383 cases) | **62%** (65% looking up to 8 links) |
| The same for `get_neighbors`, which lists by distance alone | 45% (47% walking through hubs) |
| Strengths equal to a slow second version of the rule, exactly | **515 of 515** starting nodes |
| A `find_related` call (median; 95th percentile) | 10 ms; 16 ms |
| A `find_paths` call | 8 ms; 15 ms |
| A `find_related` reply (median; largest of the 103 timed) | 7.6 kB; 12.2 kB |

<details><summary>All 42 questions, both ways</summary>

| | Question | Rows | As SPARQL | Without SPARQL | How, without SPARQL |
|---|---|---:|:---:|:---:|---|
| CQ01 | Which projects are in the consortium, with grant number and mechanism? | 33 | same | same | list the projects; read each one's properties |
| CQ02 | What is the total award amount per mechanism? | 5 | same | same | list the projects; add up their awards by mechanism |
| CQ03 | Which institution hosts each project? | 3 | same | same | from each project, the organization one link away |
| CQ04 | Who holds a role on R34DA059723, and what role? | 2 | same | same | find the project by grant number; its people, with the role on each link |
| CQ05 | Which investigators hold roles on more than one project? | 7 | same | same | from each project, its people; count the projects per person |
| CQ06 | Which organization is each investigator affiliated with? | 136 | same | same | from each organization, the people one link away |
| CQ07 | Which investigators have an ORCID? | 112 | same | same | list the investigators; read each one's ORCID |
| CQ08 | Who are the members of WG-Devices? | 66 | same | same | find the working group by name; from it, the people one link away |
| CQ09 | Which projects study the house mouse? | 7 | same | same | find the species by its common name; from it, the projects one link away |
| CQ10 | Which projects study mammals? | 25 | same | same | find the mammal species; from each, its projects |
| CQ11 | Which projects name no resolvable species, and is that by design? | 4 | same | same | list the projects; keep those with no species named |
| CQ12 | Which publications came out of which project? | 89 | same | same | from each project, the publications one link away |
| CQ13 | Which datasets were produced under which project? | 4 | same | same | from each project, the datasets one link away |
| CQ14 | Which device categories does each project use? *(not modelled)* | 0 | none | none | from each project, the device categories one link away |
| CQ15 | Which devices does each manufacturer make, by category? | 35 | same | same | from each device, its maker and its category |
| CQ16 | Which software tools does the consortium provide, with their repositories? | 18 | same | same | list the software tools; read each one's repository |
| CQ17 | Which funding opportunities are still open (expiration after 2026-09-29)? | 5 | same | same | list the funding calls; keep those still open |
| CQ18 | Which jobs are posted, and by which institution? *(needs the full export)* | 0 | none | none | list the jobs; read each one's institution |
| CQ19 | Where did R34DA059723's title come from (source class and grade)? *(needs the full export)* | 0 | none | none | list the provenance records; keep the project's title; read the source's grade |
| | **Proposed in [#441](https://github.com/brain-bbqs/bbqs-app/issues/441), not adopted yet** | | | | |
| CQ20 | Which investigators are on more than one project, and which projects? | 7 | same | same | from each project, its people; keep those on more than one |
| CQ21 | Which investigators have no ORCID recorded? | 150 | same | same | list the investigators; keep those with no ORCID |
| CQ22 | Which organization is each investigator tied to, directly or through a project? | 139 | same | same | from each person, their organization, and their projects' organizations |
| CQ23 | Who is in each working group, and on which projects are they? | 272 | same | same | from each working group, its members; from each member, their projects |
| CQ24 | Which investigators hold more than one kind of role? *(none in this export)* | 0 | none | none | from each project, its people and the role on each link |
| CQ25 | Which projects study the house mouse, whichever of its names is used? | 14 | same | same | find the species by any of its names; from it, its projects |
| CQ26 | How many projects study each species? | 13 | same | same | from each project, its species; count the projects per species |
| CQ27 | Which projects name a species in free text that is not resolved to a species node? *(none in this export)* | 0 | none | none | list the projects; keep those naming a species only in free text |
| CQ28 | How many publications, datasets, tools and models did each project produce? | 33 | same | same | from each project, count what it produced, by type |
| CQ29 | How many publications came out of each investigator's projects, and which projects? | 83 | same | same | from each project, its people and its publications |
| CQ30 | Which produced datasets have no provenance recorded? *(needs the full export)* | 0 | none | none | list the datasets; keep the produced ones no provenance record names |
| CQ31 | Which benchmarks is each ML model evaluated by, and which project produced it? *(none in this export)* | 0 | none | none | from each model, its benchmarks and the project that produced it |
| CQ32 | How many members does each organization have? | 57 | same | same | from each organization, count the members one link away |
| CQ33 | Which organizations have no members recorded? | 21 | same | same | list the organizations; keep those with no member |
| CQ34 | Which organizations have investigators on more than one project? | 10 | same | same | from each organization, its members; from each member, their projects |
| CQ35 | Which jobs does each institution advertise? *(needs the full export)* | 0 | none | none | list the jobs; group them by institution |
| CQ36 | Which kinds of role are being advertised? *(needs the full export)* | 0 | none | none | list the jobs; count them by kind |
| CQ37 | Who posted each job? *(needs the full export)* | 0 | none | none | list the jobs; read who posted each |
| CQ38 | Which projects have no outputs recorded? | 12 | same | same | list the projects; keep those that produced nothing |
| CQ39 | Which funding opportunities expire between 2026-10-14 and 2027-04-14? *(none in this export)* | 0 | none | none | list the funding calls; keep those expiring in the window |
| CQ40 | How many values come from a source graded below 3, by source and table? *(needs the full export)* | 0 | none | none | list the provenance records; read each source's grade |
| CQ41 | Which datasets did each grant fund, and who are its PIs? | 4 | same | same | from each project, the datasets it funded and its PIs |
| CQ42 | Which working groups have no member with a role on any project? *(none in this export)* | 0 | none | none | from each working group, its members; see whether any has a project |

The first 19 are the questions the knowledge graph is scored on ([`kg/competency_questions.yaml`](kg/competency_questions.yaml)). The rest are the extended set proposed in [#441](https://github.com/brain-bbqs/bbqs-app/issues/441) ([`kg/competency_questions_extended.yaml`](kg/competency_questions_extended.yaml)); they count toward nothing until that issue adopts them. A question of the form "which X has no Y" lists every X with no Y *recorded*, which in a graph still being linked is not the same as having none.

</details>

Times are over stdio on one machine (Linux x86_64, Python 3.10.20) and will differ on yours. Everything else is the same wherever it is run.
<!-- kg-mcp-benchmark:end -->

Regenerate this block with `uv run kg/bench_mcp_server.py --update README.md`.

## Tech Stack

- React 18 + TypeScript + Vite
- Tailwind CSS + shadcn/ui
- Supabase (database, auth, edge functions)
- AG Grid, D3.js, Recharts (data visualization)
- Playwright (E2E & visual regression testing)

## Getting Started

```bash
npm install
npm run dev
```

## Contributing

Report issues via the sidebar button or directly on [GitHub Issues](https://github.com/brain-bbqs/bbqs-app/issues). Feature suggestions can be submitted through the [Suggest a Feature](https://brain-bbqs.org/feature-suggestions) page.

## Automated issue handling

Issues opened by trusted filers can be classified and implemented automatically, gated by blast radius:

- **Class A** — trivial + low blast: one approving review, then auto-merge to `dev`
- **Class B** — normal app logic: standard human review before merge to `dev`
- **Class C** — touches a danger layer (migrations, RLS, auth, CI, etc.): requires Spec Kit artifacts and human sign-off, never auto-merges

See [`docs/issue-to-implementation.md`](docs/issue-to-implementation.md) for details.

## License

MIT
