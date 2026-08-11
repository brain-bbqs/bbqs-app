---
name: Sandbox Supabase environment
description: Sandbox Supabase project ref, PR-driven migration sync, and npm-built frontend deployed to a separate GitHub Pages repo
type: feature
---
# Sandbox environment

- **Sandbox Supabase ref:** `vzfsndsqveacpefoqwsu` (prod is `vpexxhfpvghlejljwpvt`).
- **Frontend:** same codebase as prod, built with `.env.sandbox` and deployed to `brain-bbqs/bbqs-website-sandbox` GitHub Pages repo. No Lovable remix.
- **Env-driven config:** `src/integrations/supabase/client.ts`, `vite.config.ts`, and `src/App.tsx` read `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_AUTH_COOKIE_DOMAIN`, and `VITE_BASE_PATH` so one codebase targets prod or sandbox.
- **PR flow:** `.github/workflows/sync-sandbox-schema.yml` runs on every PR. It posts a `supabase migration list` drift comment, pushes migrations when `SANDBOX_MIGRATIONS_ENABLED == 'true'` (or on `main`), optionally reseeds fake data, builds/deploys the frontend, runs Playwright QA against `SANDBOX_PREVIEW_URL`, and optionally auto-merges.
- **Secrets:** `SANDBOX_SUPABASE_DB_URL` **or** `SANDBOX_DB_PASSWORD` (the normalizer assembles the pooler URI from the password when the URI is missing/malformed), `SANDBOX_SUPABASE_ANON_KEY`, `STAGING_SEED_TOKEN`, `CI_AUTH_SECRET`, `SANDBOX_GITHUB_PAT`.
- **Variables:** `SANDBOX_PREVIEW_URL`, `SANDBOX_MIGRATIONS_ENABLED`, `SANDBOX_SEED_DATA_ENABLED`, `SANDBOX_DB_REGION`, `SANDBOX_AUTO_MERGE_ENABLED`.
- **Data:** NEVER copy prod data into the sandbox. Seeding is `seed-staging-fakes` only (gated on `STAGING_MODE=true` + `x-seed-token`); the old `pg_dump` prod-clone job was removed.
- **Diagnostics:** `.github/workflows/validate-db-secrets.yml` (manual) reports redacted secret shapes and tests the sandbox connection.
- **Globus sandbox client ID:** `2998008d-0e14-4458-8338-f82f2af28a88`.
- **Runbook:** `docs/SANDBOX_RUNBOOK.md`.

- Cron jobs use `public.cron_invoke(fn, body, query)` reading `project_url` / `project_service_role_key` (fallback `project_anon_key`) from Vault. No hardcoded keys in cron commands. Rotate by updating the Vault secret only.
- Staging chain (docs/SANDBOX_RUNBOOK.md): validate DB secrets -> SANDBOX_MIGRATIONS_ENABLED=true -> dispatch dry_run -> migrate -> seed -> deploy -> QA -> auto-merge.

## Data policy update (Aug 2026)
The sandbox must be an **exact clone of production data on every sync run**
(`clone-prod` job → `.github/scripts/clone-prod-to-sandbox.sh`): pg_dump prod
data-only → truncate sandbox public tables → pg_restore → row-count diff →
`sandbox-localize.sql`. Fake seeding (`seed-staging-fakes`) is now the fallback
only, used when `SANDBOX_CLONE_PROD_ENABLED=false`. Because real PII lands in
the sandbox, the sandbox carries production confidentiality.

## 2026-08-11 — pipeline stripped down
`qa.yml` (Playwright smoke/visual regression) and `sync-sandbox-schema.yml` were
DELETED at maintainer request: the Playwright suite is unused and the sandbox
pipeline is paused. Do not recreate either workflow unless asked. `guards.yml` is
now the only automatic check on PRs to `main`.
