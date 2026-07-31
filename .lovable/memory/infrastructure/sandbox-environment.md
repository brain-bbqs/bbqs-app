---
name: Sandbox Supabase environment
description: Sandbox Supabase project ref, PR-driven migration sync workflow, and remixed Lovable preview setup
type: feature
---
# Sandbox environment

- **Sandbox Supabase ref:** `vzfsndsqveacpefoqwsu` (prod is `vpexxhfpvghlejljwpvt`).
- **Frontend:** remixed Lovable project pointed at the sandbox ref. `src/integrations/supabase/client.ts` hardcodes URL/anon key and pins the auth cookie to `.brain-bbqs.org` — the remix must override both.
- **PR flow:** `.github/workflows/sync-sandbox-schema.yml` runs on PRs touching `supabase/migrations/**`. It always posts a `supabase migration list` drift comment; it pushes only when repo variable `SANDBOX_MIGRATIONS_ENABLED == 'true'`. Merges to `main` always push. Manual dispatch defaults to dry-run.
- **Secret:** `SANDBOX_SUPABASE_DB_URL` (direct Postgres URI for the sandbox).
- **Data:** never copy prod data. Seed with `seed-staging-fakes` (gated on `STAGING_MODE=true` + `x-seed-token`).
- **Globus sandbox client ID:** `2998008d-0e14-4458-8338-f82f2af28a88`.
- Runbook: `docs/SANDBOX_RUNBOOK.md`.
