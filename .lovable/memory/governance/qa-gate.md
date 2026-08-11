---
name: QA Gate
description: QA gate state — guards.yml on PRs; sandbox QA rebuilt as one manual workflow (sandbox-qa.yml)
type: feature
---
- PR gate on `main`: only `guards.yml` (`npm run test:guards`). Playwright `qa.yml` deleted (unused).
- Sandbox QA rebuilt 2026-08-11 as ONE manual workflow `.github/workflows/sandbox-qa.yml`:
  1. verify prod schema vs repo migrations (drift stops the run unless `allow_drift`),
  2. approval via `sandbox-approval` GitHub Environment,
  3. `supabase db push` to sandbox + `clone-prod-to-sandbox.sh` exact data clone + `sandbox-localize.sql`,
  4. `npm ci && npm run build` with VITE_* pointed at sandbox,
  5. deploy to GitHub Pages.
- Dispatch-only by design; add `push: dev` trigger later. Sandbox holds real prod PII.
- Secrets: SUPABASE_KG_DB_URL, SANDBOX_DB_PASSWORD (or SANDBOX_SUPABASE_DB_URL pooler URI), SANDBOX_SUPABASE_ANON_KEY. Vars: SANDBOX_PROJECT_REF, SANDBOX_DB_REGION, SANDBOX_BASE_PATH.
- Pages hosts one site per repo: a sandbox deploy overwrites publish.yml's output.
