# Roadmap and progress

How BBQS work is organised on the [project board](https://github.com/orgs/brain-bbqs/projects/6), and
how the progress page and the weekly digest are made from it. Nothing in either is written by hand.

## Three levels

| Level | What it is | How to recognise it |
|---|---|---|
| **Phase** | A stage of the roadmap, in plain language: *Knowledge Graph v1*, *Community content*, … | Issue labelled `roadmap: phase` |
| **Milestone** | An outcome with a **done when** line and a target date | Issue labelled `roadmap: milestone`, a sub-issue of its phase |
| **Work** | The technical issues that get it done | Sub-issues of the milestone |

When a work issue closes, its milestone's progress bar moves, and so does its phase's. The board's
**20,000 ft** view shows the milestones on a timeline grouped by phase; **Milestones** is the same
as a table.

Writing a milestone: the title says the outcome ("Known data errors are fixed"), the body has
**Outcome.**, **Done when.** and, until it can be measured, **Where it stands.** Set Start date and
Target date on the board. The Knowledge Graph v1 milestones report measured numbers instead of a
"where it stands" line (`KG_MEASURES` in `scripts/progress/build-progress.mjs`).

## The progress page and the weekly digest

`scripts/progress/build-progress.mjs` reads the board and writes `progress.json`, the one file every
report is made from:

- **brain-bbqs.org/progress**, the site's public Progress page (`src/pages/Progress.tsx`, in the
  sidebar under About). It reads `data/progress.json`, which `publish.yml` rebuilds from the board
  with each daily site build. `public/data/progress.json` is a committed snapshot for local and preview
  copies of the site. `/roadmap` redirects here; it replaced the hand-kept roadmap page.
- **Weekly digest**: `progress-digest.yml` runs every Monday. The digest lands in the run summary
  and as an artifact, and is posted to Slack when `SLACK_PROGRESS_WEBHOOK` is set.

Both need the repo secret **`PROJECT_READ_TOKEN`**: a fine-grained token owned by `brain-bbqs` with
*Projects: read* and *Issues: read*. GitHub's built-in token cannot read org projects. Without the
secret, the page shows the committed snapshot and the site still deploys.

Both reports end with the open issues that have **no phase or milestone**. Attach each one to the
roadmap, or close it.

## Every non-trivial change is tracked

`track-work.yml` (rules in `scripts/tracking/`, guarded by `tests/guards/work-tracking.test.mjs`):

- **Pull requests** get a `tracked` check. It passes when the PR or one of its commits names its
  issue with a keyword: `Refs #421`, `Closes #12`, `Part of #386`, or an issue link. A bare `#7`
  doesn't count, because commits here use that for KG invariants. It also passes when the change
  is small (up to 40 lines in 3 files, generated files aside), when the PR is labelled `trivial`,
  or when it's a `dev` → `main` release.
- **Pushes without a PR**, which only the repo owner can make: any commit that names no issue and
  isn't trivial is listed in an open **Untracked work on &lt;branch&gt;** issue. That issue appears in
  the progress report until the work is attached to the right issue.

Tag a genuinely small change `[trivial]` in its commit message or PR title.
