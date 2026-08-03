---
name: Sandbox Supabase environment
description: Sandbox Supabase project ref, PR-driven migration sync, and npm-built frontend deployed to a separate GitHub Pages repo
type: feature
---
# Sandbox environment

- **Sandbox Supabase ref:** `vzfsndsqveacpefoqwsu` (prod is `vpexxhfpvghlejljwpvt`).
- **Frontend:** same codebase as prod, built with `.env.sandbox` and deployed to `brain-bbqs/bbqs-website-sandbox` GitHub Pages repo. No Lovable remix.
- **Env-driven config:** `src/integrations/supabase/client.ts`, `vite.config.ts`, and `src/App.tsx` read `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_AUTH_COOKIE_DOMAIN`, and `VITE_BASE_PATH` so one codebase targets prod or sandbox.
- **PR flow:** `.github/workflows/sync-sandbox-schema.yml` runs on every PR. It posts a `supabase migration list` drift comment, pushes migrations when `SANDBOX_MIGRATIONS_ENABLED == 'true'` (or on `main`), builds/deploys the frontend, runs Playwright QA against `SANDBOX_PREVIEW_URL`, and optionally auto-merges.
- **Secrets:** `SANDBOX_SUPABASE_DB_URL`, `SANDBOX_SUPABASE_ANON_KEY`, `CI_AUTH_SECRET`, `SANDBOX_GITHUB_PAT`.
- **Variables:** `SANDBOX_PREVIEW_URL`, `SANDBOX_MIGRATIONS_ENABLED`, `SANDBOX_AUTO_MERGE_ENABLED`.
- **Data:** never copy prod data. Seed with `seed-staging-fakes` (gated on `STAGING_MODE=true` + `x-seed-token`).
- **Globus sandbox client ID:** `2998008d-0e14-4458-8338-f82f2af28a88`.
- **Runbook:** `docs/SANDBOX_RUNBOOK.md`.
