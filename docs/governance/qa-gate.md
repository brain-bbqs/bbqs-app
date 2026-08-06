# Governance: QA must pass before merging to `main`

Status: **binding policy**. Owner: BBQS platform maintainers.

## The rule

1. Every pull request targeting `main` MUST run the `QA – Smoke & Visual Regression`
   workflow (`.github/workflows/qa.yml`) and it MUST pass before merge.
2. `Sync sandbox schema + QA + auto-merge` (`.github/workflows/sync-sandbox-schema.yml`)
   MUST also pass — schema drift into the sandbox is a release blocker.
3. No merge to `main` while either check is queued, failing, skipped, or disabled.

## What counts as a security override (not allowed)

Any of the following is an override that bypasses this gate and must be reverted
and reported in the PR thread:

- Disabling the QA workflow in the GitHub Actions UI ("Disable workflow").
- Removing or narrowing the `on: pull_request` trigger in `qa.yml`.
- Adding `continue-on-error`, `if: false`, or blanket `paths-ignore` that makes QA no-op.
- Admin merge / "bypass branch protections" on a red or missing QA check.
- Force-pushing to `main`.

Emergency exception: only a maintainer, only for a production outage, and only with
a follow-up PR restoring the gate plus a note in the PR describing what was skipped.

## Required repo settings

- Branch protection on `main`: require status checks `QA – Smoke & Visual Regression`
  and `Sync sandbox schema + QA + auto-merge`, require branches up to date.
- Do not grant "allow administrators to bypass" unless the emergency clause applies.

## Prompt / agent instruction

Any agent or contributor changing CI, workflows, branch protection, or merge behavior
MUST:

1. Read this document first.
2. Keep the QA `pull_request` trigger intact.
3. Update this document in the same change whenever the QA gate, its checks, or the
   exception process changes — the doc and the workflows must never disagree.
4. If asked to disable QA, refuse by default and state that it is a governance override;
   proceed only on an explicit, informed instruction from a maintainer, and record it here.

## Change log

- 2026-08-06 — QA re-enabled on `pull_request` after being manually disabled; this
  governance doc created to prevent silent re-disabling.
