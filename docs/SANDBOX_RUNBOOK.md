# BBQS Sandbox Environment — Runbook

Sandbox Supabase project: **`vzfsndsqveacpefoqwsu`** (`https://vzfsndsqveacpefoqwsu.supabase.co`)
Prod Supabase project: `vpexxhfpvghlejljwpvt` — never touched by anything in this doc.

The sandbox uses the **same frontend codebase** as production. The only differences are:

1. The frontend is built with `.env.sandbox`, pointing it at the sandbox Supabase.
2. A GitHub Action applies migrations to the sandbox Supabase and deploys the built frontend to a separate GitHub Pages repo (`brain-bbqs/bbqs-website-sandbox`).
3. Playwright QA runs against the deployed sandbox preview URL.

There is **no Lovable remix** to maintain.

---

## 1. Get the sandbox Supabase credentials

Supabase dashboard → project `vzfsndsqveacpefoqwsu` → **Connect → Session pooler → URI**:

```
postgresql://postgres.vzfsndsqveacpefoqwsu:<DB_PASSWORD>@<region>.pooler.supabase.com:5432/postgres
```

Use the **Session pooler** on port `5432`, not the direct
`db.vzfsndsqveacpefoqwsu.supabase.co` host. GitHub-hosted runners are IPv4-only,
while the direct Supabase database hostname is IPv6-only.

Also copy from **Settings → API**:

- anon / public key → `<sandbox-anon-key>`
- service_role key (keep private)

---

## 2. Create the sandbox frontend repo

Create an empty GitHub repo named **`brain-bbqs/bbqs-website-sandbox`**.

Enable GitHub Pages on it:

1. **Settings → Pages → Source** → select **Deploy from a branch** → pick `gh-pages` → **Save**.
2. (Recommended) Add a custom domain like `sandbox.brain-bbqs.org` and create the matching DNS CNAME record.

If you use the default GitHub Pages URL (`https://brain-bbqs.github.io/bbqs-website-sandbox`), you must keep `VITE_BASE_PATH=/bbqs-website-sandbox/` in `.env.sandbox`. If you use a custom domain, change it to `VITE_BASE_PATH=/`.

---

## 3. Add GitHub Actions secrets/variables

In the **prod** repo (`brain-bbqs/brain-bbq-clone`), go to **Settings → Secrets and variables → Actions**.

**Repository secrets:**

| Name | Value |
|---|---|
| `SANDBOX_SUPABASE_DB_URL` | sandbox Session pooler URI from step 1 |
| `SANDBOX_DB_PASSWORD` | sandbox DB password. **Fallback** — if `SANDBOX_SUPABASE_DB_URL` is missing or malformed, the workflow assembles `postgresql://postgres.vzfsndsqveacpefoqwsu:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` from this. Setting it alone is enough. |
| `STAGING_SEED_TOKEN` | same value as `STAGING_SEED_TOKEN` in the sandbox edge-function secrets; used to invoke `seed-staging-fakes` |
| `SANDBOX_SUPABASE_ANON_KEY` | the anon key from step 1 |
| `CI_AUTH_SECRET` | shared token used by the `ci-auth` edge function to bypass Globus in tests |
| `SANDBOX_GITHUB_PAT` | classic PAT with `repo` scope (and SSO authorized if the org uses SAML) for `brain-bbqs/bbqs-website-sandbox` |

**Repository variables:**

| Name | Value | Effect |
|---|---|---|
| `SANDBOX_PREVIEW_URL` | `https://<sandbox-host>` | URL QA targets. Example: `https://brain-bbqs.github.io/bbqs-website-sandbox` or `https://sandbox.brain-bbqs.org`. **Required** for the QA job. |
| `SANDBOX_MIGRATIONS_ENABLED` | `true` | PRs actually push migrations to sandbox. Leave unset for drift-report-only on PRs. |
| `SANDBOX_SEED_DATA_ENABLED` | `true` | Reseed the sandbox with generated fake rows on every run. Leave unset to seed only on manual dispatch. |
| `SANDBOX_DB_REGION` | e.g. `us-east-1` | Pooler region used when the DB URI is assembled from `SANDBOX_DB_PASSWORD`. Defaults to `us-east-1`. |
| `SANDBOX_AUTO_MERGE_ENABLED` | `true` | Enables auto-merge after sandbox QA passes. Leave unset to keep QA reports only. |

### Diagnosing a bad DB secret

Run **Actions → Validate DB secrets → Run workflow**. It reports which secrets
are present (lengths only, never values), normalizes the connection string, and
runs a single `select` against the sandbox database. Use it before re-running
the full pipeline.

Merges to `main` always push migrations. Manual workflow runs default to dry-run.

---

## 4. First full schema sync (one time)

```bash
supabase db push --db-url "$SANDBOX_SUPABASE_DB_URL" --include-all
```

Or: **Actions → Sync sandbox schema → Run workflow → dry_run = false**.

---

## 5. Sandbox edge-function secrets

In the sandbox Supabase project, **Settings → Edge Functions → Secrets**, add the non-prod equivalents your functions need. At minimum:

```
GLOBUS_CLIENT_ID      = 2998008d-0e14-4458-8338-f82f2af28a88
GLOBUS_CLIENT_SECRET  = <sandbox Globus secret>
CI_AUTH_SECRET        = <same value as the GitHub Actions secret>
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are auto-injected.

Register the sandbox Globus redirect URI as `https://<sandbox-host>/auth/callback`.

---

## 6. Filling the sandbox with data

There are two mutually exclusive modes. **Exact clone is the default.**

### 6a. Exact clone of production (default)

Every run, after migrations are pushed, the `clone-prod` job dumps production's
data and restores it into the sandbox, so the sandbox is a byte-for-byte copy of
prod's rows (`.github/scripts/clone-prod-to-sandbox.sh`):

1. `pg_dump --data-only` of `public` (plus `auth` and `storage` unless
   `SANDBOX_CLONE_AUTH=false`), excluding session/refresh-token tables.
2. `TRUNCATE ... RESTART IDENTITY CASCADE` on every sandbox `public` table.
3. `pg_restore --data-only --disable-triggers` into the sandbox.
4. A per-table row-count comparison prod vs sandbox is printed; mismatches are
   flagged in the log.
5. `.github/sql/sandbox-localize.sql` runs again to unschedule cron and clear
   any prod credential.

Requires one of these secrets: `PROD_SUPABASE_DB_URL` (production Session
pooler URI) or `PROD_DB_PASSWORD`. The script refuses to run if the *target*
URL points at the production ref.

> **Confidentiality:** cloning copies real data, including PII. The sandbox now
> carries production confidentiality — restrict access to the same people who
> can read prod, and never expose the sandbox site publicly. Set repo variable
> `SANDBOX_CLONE_PROD_ENABLED=false` to go back to fake data.

### 6b. Generated fake data (when cloning is off)

Used only when `SANDBOX_CLONE_PROD_ENABLED=false`. Use `supabase/functions/seed-staging-fakes/` (faker-generated rows matching prod row counts, gated on `STAGING_MODE=true` plus a shared `x-seed-token`). Deploy it to the sandbox and set:

```
STAGING_MODE=true
STAGING_SEED_TOKEN=<random 32 chars>
```

Then:

```bash
curl -X POST "https://vzfsndsqveacpefoqwsu.supabase.co/functions/v1/seed-staging-fakes" \
  -H "Authorization: Bearer <sandbox-anon-key>" \
  -H "x-seed-token: <STAGING_SEED_TOKEN>" -d '{}'
```

---

## 7. Local development against sandbox

You can run the same frontend locally against the sandbox backend:

```bash
cp .env.sandbox .env.local
# edit .env.local and replace SANDBOX_ANON_KEY_PLACEHOLDER with the real sandbox anon key
npm install
npm run dev
```

Because `VITE_AUTH_COOKIE_DOMAIN` is empty in `.env.sandbox`, auth cookies will be path-only on `localhost`, which works fine for local testing.

---

## 8. Day-to-day PR flow

1. Open a PR.
2. The workflow posts a **drift report comment** listing pending migrations (if any).
3. If `SANDBOX_MIGRATIONS_ENABLED=true` and the PR touches `supabase/migrations/`, those migrations are applied to the sandbox.
3b. Unless `SANDBOX_CLONE_PROD_ENABLED=false`, the workflow clones production data into the sandbox (exact copy). When cloning is off and `SANDBOX_SEED_DATA_ENABLED=true`, it calls `seed-staging-fakes` instead.
4. The workflow **builds the frontend with `.env.sandbox`** and deploys it to `brain-bbqs/bbqs-website-sandbox`.
5. If `SANDBOX_PREVIEW_URL` is set, the workflow runs the **Sandbox QA** job: Playwright functional tests against the live sandbox preview (`api-health`, `data-integrity`, `console-errors`, `navigation`, `smoke`).
6. If Sandbox QA passes and `SANDBOX_AUTO_MERGE_ENABLED=true`, the workflow enables GitHub auto-merge (`gh pr merge --auto --squash`). The PR merges once all required status checks and branch-protection rules are satisfied.
7. On merge to `main`, the sandbox migrations are pushed again (idempotent), and `sync-prod-schema.yml` handles prod separately.

### Branch protection recommendation

For the auto-merge step to actually merge the PR when QA passes, configure the branch protection rule for `main` to require only the **Sandbox QA** check from this workflow. If required reviews or other checks are enabled, auto-merge will wait for those as well.

---

## 9. Troubleshooting

- **`Missing secret SANDBOX_SUPABASE_DB_URL`** — step 3 not done.
- **`Missing variable SANDBOX_PREVIEW_URL`** — add the sandbox preview URL.
- **`Missing secret SANDBOX_GITHUB_PAT`** — add a classic PAT with `repo` scope. If the org uses SAML/SSO, authorize the token for the org.
- **`401 Bad credentials` from the deploy step** — the PAT is expired, missing `repo` scope, or not SSO-authorized.
- **PR shows drift but nothing applied** — `SANDBOX_MIGRATIONS_ENABLED` variable is not `true`.
- **QA passes but PR did not merge** — check branch protection rules and `SANDBOX_AUTO_MERGE_ENABLED`.
- **Push fails on an old migration** — run once with `--include-all` from your machine to backfill history.
- **Assets 404 on the sandbox site** — check that `VITE_BASE_PATH` in `.env.sandbox` matches your Pages URL. For a custom domain it should be `/`; for `https://brain-bbqs.github.io/bbqs-website-sandbox` it should be `/bbqs-website-sandbox/`.

---

## Staging a change for testing — the exact chain

This is the order the pipeline runs in, and the order you should work in. Each
step gates the next: nothing is deployed or tested until the migration lands.

```text
open PR
  │
  ├─ 1. migrate         list drift → push migrations to sandbox DB
  │                     → neutralize prod pointers (sandbox-localize.sql)
  │
  ├─ 2. seed-data       (optional) call seed-staging-fakes on sandbox
  │        needs: migrate
  │
  ├─ 3. deploy-frontend build with .env.sandbox → push to bbqs-website-sandbox gh-pages
  │        needs: migrate
  │
  ├─ 4. qa              Playwright against the deployed sandbox URL
  │        needs: deploy-frontend
  │
  └─ 5. auto-merge      squash-merge the PR (only if SANDBOX_AUTO_MERGE_ENABLED=true)
           needs: qa
```

### One-time setup (do this before the first real test)

1. **Validate the DB secret.** Actions → **Validate DB secrets** → *Run workflow*.
   It prints redacted secret shapes and runs one `select` against the sandbox.
   Do not proceed until this is green — every other job depends on it.
2. **Turn on migration pushes.** Settings → Secrets and variables → Actions →
   *Variables* → `SANDBOX_MIGRATIONS_ENABLED = true`. Without it, PRs only
   produce a drift comment and nothing is applied.
3. **Turn on seeding** (first run at least): `SANDBOX_SEED_DATA_ENABLED = true`.
4. Leave `SANDBOX_AUTO_MERGE_ENABLED` **unset** until you've watched a few full
   runs pass.

### Dry run before touching a PR

Actions → **Sync sandbox schema + QA + auto-merge** → *Run workflow*:

- `dry_run: true` → only lists pending migrations. Read the list; if it contains
  a migration you didn't expect, stop and reconcile before pushing.
- Then re-run with `dry_run: false`, `seed_data: true` to actually apply the
  schema and seed fakes. This is the safest way to prime a fresh sandbox.

### Then, per change

1. Branch off `dev`, add the migration + code, open a PR into `dev`.
2. Read the **schema drift comment** the workflow posts on the PR.
3. Watch `migrate` → `deploy-frontend` → `qa` in order. A red `migrate` means
   nothing downstream ran — fix the SQL, push, the chain restarts.
4. Open the sandbox preview URL and click through the change by hand.
5. Merge to `dev`; `dev → main` triggers the push-to-main path.
6. Apply the same migrations to production via the **Sync prod schema**
   workflow (defaults to dry-run; needs `PROD_MIGRATIONS_ENABLED=true`).

### Scheduled jobs in the sandbox

`sandbox-localize.sql` unschedules **every** `pg_cron` job in the sandbox right
after migrations, so the sandbox scheduler can never fire at production. Cron
behavior is therefore not testable in the sandbox — invoke the edge function
directly with curl if you need to exercise it.

### Cron credentials (production)

All scheduled HTTP jobs now go through `public.cron_invoke(function, body, query)`,
which reads the project URL and credential from the Vault (`project_url`,
`project_service_role_key`, falling back to `project_anon_key`). No key is
hardcoded in a cron command anymore. To rotate: update the vault secret in
Supabase → Vault; nothing else needs to change.
