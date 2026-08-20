# Flip the promotion direction: dev → sandbox, main → prod (after QA)

Today the flow is inverted:
- `sandbox-qa.yml` is **manual only** (`workflow_dispatch`) → the sandbox lags behind dev.
- `sync-prod-schema.yml` auto-runs on `push: main` (when `PROD_MIGRATIONS_ENABLED=true`) → prod can move before the sandbox has proven the change.
- `publish.yml` builds the prod site on every `push: main` regardless of QA outcome.

Target flow:

```text
push to dev ──► sandbox-qa (auto)
                  ├─ clone prod → sandbox
                  ├─ apply migrations to sandbox
                  ├─ build + deploy sandbox site
                  └─ Playwright smoke QA
                        │
                        ▼ (green)
        open/auto-merge PR: dev → main
                        │
                        ▼
push to main ──► prod migrate + publish
                  (gated on the sandbox-qa run for the same SHA being green)
```

## Changes

1. **`sandbox-qa.yml` — add auto trigger on `dev`.**
   - Add `push: branches: [dev]` alongside `workflow_dispatch`.
   - Keep manual inputs; when triggered by push, use defaults (clone data on, deploy on, smoke on, smoke_soft_fail off) so a red smoke fails the run.
   - Keep the human approval gate only when `verify-prod` reports drift; skip it on clean auto-runs so dev pushes flow through without a click.

2. **`sync-prod-schema.yml` — require green sandbox before prod migrate.**
   - Remove auto-apply on `push: main`. Replace with `workflow_run` trigger: run **after** `Sandbox QA` completes successfully on `main`.
   - Keep `workflow_dispatch` with `dry_run` for emergency manual runs.
   - Retain the `PROD_MIGRATIONS_ENABLED` gate.

3. **`publish.yml` — gate prod site build on the same sandbox QA.**
   - Replace `push: branches: [main]` with `workflow_run: workflows: ["Sandbox QA (clone prod -> build -> sandbox repo)"], branches: [main], types: [completed]`.
   - Guard job with `if: github.event.workflow_run.conclusion == 'success'`.
   - Keep `workflow_dispatch` for manual re-publish.

4. **Branch protection guidance (docs only, no code):**
   - `main` should require the `Sandbox QA` check to pass on the PR head before merge. Update `docs/SANDBOX_RUNBOOK.md` and `docs/governance/qa-gate.md` to describe the new dev → sandbox → main → prod chain.

5. **Memory update:** refresh `.lovable/memory/governance/qa-gate.md` and `.lovable/memory/infrastructure/sandbox-environment.md` to reflect: sandbox-qa auto-runs on `dev`; prod migrate + publish gated on sandbox QA success on `main`.

## Out of scope
- No changes to `guards.yml`, `db-backup.yml`, or edge-function deploys.
- No new secrets or environments required; reuses existing `SANDBOX_*` and `SUPABASE_KG_DB_URL` secrets.
- Auto-merge of `dev → main` PRs stays a separate follow-up (still human-opened).
