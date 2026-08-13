# BBQS — Brain Behavior Quantification and Synchronization

[![Sandbox QA](https://github.com/brain-bbqs/bbqs-website/actions/workflows/sandbox-qa.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-website/actions/workflows/sandbox-qa.yml)
[![Database Backup](https://github.com/brain-bbqs/bbqs-website/actions/workflows/db-backup.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-website/actions/workflows/db-backup.yml)
[![Guards](https://github.com/brain-bbqs/bbqs-website/actions/workflows/guards.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-website/actions/workflows/guards.yml)
[![Deploy](https://github.com/brain-bbqs/bbqs-website/actions/workflows/publish.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-website/actions/workflows/publish.yml)

The **BBQS** program is an NIH-funded basic research initiative to develop new tools and approaches for a more comprehensive, mechanistic understanding of the neural basis of behavior. This repository powers the [BBQS consortium website](https://brain-bbqs.org), serving as the central hub for the community.

## Status

| | Pipeline | Status |
|---|---|---|
| ✅ | Sandbox QA | [![Sandbox QA](https://github.com/brain-bbqs/bbqs-website/actions/workflows/sandbox-qa.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-website/actions/workflows/sandbox-qa.yml) |
| ✅ | Backup | [![Database Backup](https://github.com/brain-bbqs/bbqs-website/actions/workflows/db-backup.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-website/actions/workflows/db-backup.yml) |
| ✅ | Guards | [![Guards](https://github.com/brain-bbqs/bbqs-website/actions/workflows/guards.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-website/actions/workflows/guards.yml) |
| ✅ | Deploy | [![Deploy](https://github.com/brain-bbqs/bbqs-website/actions/workflows/publish.yml/badge.svg)](https://github.com/brain-bbqs/bbqs-website/actions/workflows/publish.yml) |

Green badge = live, red = dead.

## About the Program

BBQS brings together a cross-disciplinary consortium of researchers to:

- **Measure behavior** — Develop tools for simultaneous, multimodal measurement of behavior within complex, dynamic physical and social environments, synchronized with neural recordings.
- **Model brain-behavior relationships** — Create novel computational models that capture dynamic behavior-environment relationships across multiple timescales, integrated with correlated neural activity.
- **Share data and tools** — Establish shared data archives (EMBER), ontologies, standards, and ethical frameworks that transform how mechanistic brain-behavioral research is conducted.

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

Report issues via the sidebar button or directly on [GitHub Issues](https://github.com/brain-bbqs/brain-bbq-clone/issues). Feature suggestions can be submitted through the [Suggest a Feature](https://brain-bbqs.org/feature-suggestions) page.

## License

MIT
