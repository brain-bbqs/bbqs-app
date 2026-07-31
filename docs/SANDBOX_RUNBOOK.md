# BBQS Sandbox Environment — Runbook

Sandbox Supabase project: **`vzfsndsqveacpefoqwsu`** (`https://vzfsndsqveacpefoqwsu.supabase.co`)
Prod Supabase project: `vpexxhfpvghlejljwpvt` — never touched by anything in this doc.

The sandbox is a **remixed Lovable project** pointed at the sandbox Supabase, with
schema kept in sync from pull requests by
`.github/workflows/sync-sandbox-schema.yml`.

---

## 1. Get the sandbox DB connection string

Supabase dashboard → project `vzfsndsqveacpefoqwsu` → **Settings → Database → Connection string → URI**:

```
postgresql://postgres:<DB_PASSWORD>@db.vzfsndsqveacpefoqwsu.supabase.co:5432/postgres
```

Also copy from **Settings → API**:
- anon / public key → `<sandbox-anon-key>`
- service_role key (keep private)

---

## 2. Add GitHub Actions secrets/variables

**Settings → Secrets and variables → Actions**

Repository **secret**:

| Name | Value |
|---|---|
| `SANDBOX_SUPABASE_DB_URL` | the URI from step 1 |

Repository **variable** (optional):

| Name | Value | Effect |
|---|---|---|
| `SANDBOX_MIGRATIONS_ENABLED` | `true` | PRs actually push migrations to sandbox. Leave unset for drift-report-only on PRs. |

Merges to `main` always push. Manual runs default to dry-run.

---

## 3. First full sync (one time)

```bash
supabase db push --db-url "$SANDBOX_SUPABASE_DB_URL" --include-all
```

Or: **Actions → Sync sandbox schema (PR) → Run workflow → dry_run = false**.

---

## 4. Remix the Lovable project

1. Project name (top left) → **Settings → Remix this project**, name it `bbqs-sandbox`.
2. In the remix, set:
   ```
   VITE_SUPABASE_URL=https://vzfsndsqveacpefoqwsu.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=<sandbox-anon-key>
   VITE_SUPABASE_PROJECT_ID=vzfsndsqveacpefoqwsu
   ```
3. Also update `src/integrations/supabase/client.ts` in the remix — the URL and
   anon key are hardcoded there, and the auth cookie domain is pinned to
   `.brain-bbqs.org`. For the sandbox, drop the shared-cookie storage so the
   session lives on the sandbox host.
4. Publish the remix and note its URL.

---

## 5. Sandbox secrets (edge functions)

In the sandbox project, **Settings → Edge Functions → Secrets**, add the
non-prod equivalents your functions need. At minimum:

```
GLOBUS_CLIENT_ID      = 2998008d-0e14-4458-8338-f82f2af28a88
GLOBUS_CLIENT_SECRET  = <sandbox Globus secret>
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are auto-injected.

Register the sandbox Globus redirect URI as `https://<sandbox-host>/auth/callback`.

---

## 6. Seeding data

**No prod data is ever copied.** Use `supabase/functions/seed-staging-fakes/`
(faker-generated rows matching prod row counts, gated on `STAGING_MODE=true`
plus a shared `x-seed-token`). Deploy it to the sandbox and set:

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

## 7. Day-to-day flow

1. Open a PR that adds files under `supabase/migrations/`.
2. The workflow posts a **drift report comment** listing pending migrations.
3. If `SANDBOX_MIGRATIONS_ENABLED=true`, those migrations are applied to the
   sandbox immediately, so the sandbox preview reflects the PR's schema.
4. On merge to `main`, the sandbox is pushed again (idempotent), and
   `sync-prod-schema.yml` handles prod separately.

### Troubleshooting

- **`Missing secret SANDBOX_SUPABASE_DB_URL`** — step 2 not done.
- **PR shows drift but nothing applied** — `SANDBOX_MIGRATIONS_ENABLED` variable is not `true`.
- **Push fails on an old migration** — run once with `--include-all` from your machine to backfill history.
