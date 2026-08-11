# Governance: merge gate for `main`

Status: **guards only on PRs; sandbox QA is manual**. Owner: BBQS platform maintainers.

## Current state (2026-08-11)

The Playwright suite (`qa.yml`) and the old sandbox sync workflow
(`sync-sandbox-schema.yml`) were deleted. The sandbox pipeline was then rebuilt
from scratch as a single **manually triggered** workflow:

- `Sandbox QA (clone prod -> build -> sandbox repo)` — `.github/workflows/sandbox-qa.yml`

### What it does, in order

1. **Verify production schema.** `supabase migration list` against production
   (`SUPABASE_KG_DB_URL`). Any migration present locally but not remotely — or
   applied by hand and missing from the repo — is drift. Drift **stops the run**
   unless the operator dispatches with `allow_drift = true`.
2. **Approval.** The `sandbox-approval` GitHub Environment. Add required
   reviewers in Settings → Environments; that is what makes this a real gate.
   Nothing touches data before someone approves.
3. **Migrate + clone sandbox.** `supabase db push` to the sandbox project, then
   `clone-prod-to-sandbox.sh` copies production rows in so the sandbox is an
   exact replica, then `sandbox-localize.sql` neutralizes prod-only cron jobs
   and vault secrets.
4. **Build.** `npm ci && npm run build` with `VITE_SUPABASE_URL` /
   `VITE_SUPABASE_PUBLISHABLE_KEY` pointed at the sandbox project.
5. **Publish.** The `dist/` build is force-pushed to a **separate sandbox
   repository** (`vars.SANDBOX_PAGES_REPO`, branch `gh-pages`) that owns its own
   GitHub Pages site and URL. Production's Pages deploy (`publish.yml`) is never
   touched, and the two can run independently.

> The sandbox clone contains real production data, including PII. The sandbox
> database **and the sandbox site repository** must therefore be private and
> limited to the same people who can read production.

### Required configuration

Secrets: `SUPABASE_KG_DB_URL`, `SANDBOX_DB_PASSWORD` (or
`SANDBOX_SUPABASE_DB_URL` as a `postgresql://` Session pooler URI),
`SANDBOX_SUPABASE_ANON_KEY`, `SANDBOX_GITHUB_PAT` (write access to the sandbox
site repo).
Variables: `SANDBOX_PAGES_REPO` (`owner/repo` of the sandbox site repository —
required to publish), and optionally `SANDBOX_PAGES_BRANCH` (default `gh-pages`),
`SANDBOX_PROJECT_REF` (default `vzfsndsqveacpefoqwsu`), `SANDBOX_DB_REGION`,
`SANDBOX_BASE_PATH` (set to `/<repo-name>/` unless the sandbox repo is a
`<user>.github.io` site).

The only automatic gate on pull requests into `main` is:

- `Guards – cross-layer invariants` (`.github/workflows/guards.yml`) — fast static
  checks via `npm run test:guards`.

## The rule

1. Every pull request targeting `main` MUST run and pass `guards.yml`.
2. No merge to `main` while that check is queued, failing, skipped, or disabled.
3. Disabling `guards.yml`, adding `continue-on-error`/`if: false`, admin-merging past
   a red check, or force-pushing to `main` remain governance overrides and are not allowed.

4. `sandbox-qa.yml` is dispatch-only on purpose. Adding `push`/`pull_request`
   triggers, or removing the `sandbox-approval` environment, is a governance
   change and must be reflected here in the same commit.

## Restoring automatic QA

When the loop is green by hand, add `push: branches: [dev]` to `sandbox-qa.yml`
first, then a `pull_request` trigger and a required status check in branch
protection — updating this document in the same change.

## Prompt / agent instruction

Any agent or contributor changing CI, workflows, branch protection, or merge behavior
MUST read this document first and update it in the same change whenever the gate
changes — the doc and the workflows must never disagree.

## Change log

- 2026-08-06 — QA re-enabled on `pull_request`; this governance doc created.
- 2026-08-11 — QA and sandbox sync workflows deleted at maintainer request (Playwright
  suite unused, sandbox pipeline paused). `guards.yml` is the sole automatic gate.
- 2026-08-11 — Sandbox QA rebuilt from scratch as one manual workflow
  (`sandbox-qa.yml`): prod drift check → approval → clone → npm build → Pages.
- 2026-08-11 — Sandbox site moved out of this repo: the build is published to a
  separate sandbox repository with its own Pages URL, so production Pages is
  never overwritten.
