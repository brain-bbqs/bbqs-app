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

The second command starts the server the way a client does and asks it every [competency question](kg/competency_questions.yaml) twice, once as SPARQL and once without SPARQL through the graph tools, checking both against the export queried directly. It then measures the ranking and the speed. `--show CQ04` prints one question's rows; `--only questions` skips the measurements. Without [uv](https://docs.astral.sh/uv/), run `pip install -r kg/requirements.txt -r kg/requirements-mcp.txt` and use `python` in place of `uv run`.

To talk to it from Claude Code (give the full path to your checkout):

```bash
claude mcp add bbqs-kg -- uv run /path/to/bbqs-app/kg/mcp_server.py
```

### Benchmark

<!-- kg-mcp-benchmark:start -->
Graph: 703 nodes, 791 links, export of 2026-11-05. Server 0.2.0.

| | Result |
|---|---|
| Competency questions with an answer in this export | **16 of 19** (2 need the full export, 1 not modelled yet) |
| Those 16, asked as SPARQL through the server: same rows as the export queried directly | **16 of 16** |
| Those 16, asked without SPARQL through the graph tools: same rows again | **16 of 16** |
| A hidden tie is in the first ten `find_related` returns (1,383 cases) | **62%** (65% looking up to 8 links) |
| The same for `get_neighbors`, which lists by distance alone | 45% (47% walking through hubs) |
| Strengths equal to a slow second version of the rule, exactly | **515 of 515** starting nodes |
| A `find_related` call (median; 95th percentile) | 10 ms; 16 ms |
| A `find_paths` call | 6 ms; 14 ms |
| A `find_related` reply (median; largest) | 7.6 kB; 12.2 kB |

<details><summary>Every question, both ways</summary>

| | Question | Rows | As SPARQL | Without SPARQL | How, without SPARQL |
|---|---|---:|:---:|:---:|---|
| CQ01 | Which projects are in the consortium, with grant number and mechanism? | 33 | same | same | list the projects; read each one's properties |
| CQ02 | What is the total award amount per mechanism? | 5 | same | same | list the projects; add up their awards by mechanism |
| CQ03 | Which institution hosts each project? | 3 | same | same | from each project, the organization one link away |
| CQ04 | Who holds a role on R34DA059723, and what role? | 2 | same | same | from the project, the people one link away, with the role on the link |
| CQ05 | Which investigators hold roles on more than one project? | 7 | same | same | from each project, its people; count the projects per person |
| CQ06 | Which organization is each investigator affiliated with? | 136 | same | same | from each organization, the people one link away |
| CQ07 | Which investigators have an ORCID? | 112 | same | same | list the investigators; read each one's ORCID |
| CQ08 | Who are the members of WG-Devices? | 66 | same | same | from the working group, the people one link away |
| CQ09 | Which projects study the house mouse? | 7 | same | same | from the species, the projects one link away |
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
