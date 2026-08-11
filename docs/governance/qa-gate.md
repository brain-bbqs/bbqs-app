# Governance: merge gate for `main`

Status: **suspended (QA + sandbox sync)**. Owner: BBQS platform maintainers.

## Current state (2026-08-11)

At the explicit instruction of a maintainer, the Playwright QA workflow
(`qa.yml`) and the sandbox sync workflow (`sync-sandbox-schema.yml`) have been
**deleted**. The Playwright suite was not being used and the sandbox pipeline is
paused, so both were removed rather than left red or disabled in the UI.

The only automatic gate on pull requests into `main` is now:

- `Guards – cross-layer invariants` (`.github/workflows/guards.yml`) — fast static
  checks via `npm run test:guards`.

## The rule while suspended

1. Every pull request targeting `main` MUST run and pass `guards.yml`.
2. No merge to `main` while that check is queued, failing, skipped, or disabled.
3. Disabling `guards.yml`, adding `continue-on-error`/`if: false`, admin-merging past
   a red check, or force-pushing to `main` remain governance overrides and are not allowed.

## Restoring QA

When the E2E suite is worth running again, restore `qa.yml` with an
`on: pull_request` trigger for `main`, re-add it as a required status check in
branch protection, and update this document in the same change.

## Prompt / agent instruction

Any agent or contributor changing CI, workflows, branch protection, or merge behavior
MUST read this document first and update it in the same change whenever the gate
changes — the doc and the workflows must never disagree.

## Change log

- 2026-08-06 — QA re-enabled on `pull_request`; this governance doc created.
- 2026-08-11 — QA and sandbox sync workflows deleted at maintainer request (Playwright
  suite unused, sandbox pipeline paused). `guards.yml` is the sole automatic gate.
