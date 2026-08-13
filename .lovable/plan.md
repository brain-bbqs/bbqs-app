# Step 5 — Generic Playwright smoke QA against the sandbox

A single, deliberately dumb smoke suite that answers one question after every sandbox
deploy: *does the sandbox actually work?* No business assertions, no fixtures, no auth
flows — just pages render, edge functions respond, tables return rows.

## What gets tested

**A. Pages load (public routes)**
For every public route in the sidebar/route table: navigate, expect HTTP 200-ish render,
expect an `<h1>` or main content, and assert **zero uncaught page errors** and no failed
`/assets/*` requests. Auth-gated routes are asserted to redirect to `/auth` rather than
crash. One screenshot per route on failure only.

**B. Tables load with data**
Directly against the sandbox Supabase REST endpoint with the sandbox anon key, one
`HEAD ?select=id&count=exact` per core table: `grants`, `investigators`, `publications`,
`resources`, `species`, `organizations`, `announcements`, `jobs`, `grant_investigators`,
`funding_opportunities`, `software_tools`, `projects`. Pass = HTTP 200 **and** count > 0.
Expected minimums come from `supabase/functions/seed-staging-fakes/prod-counts.json`,
applied loosely (>= 50% of the prod snapshot) so a clone that silently copied nothing fails.

**C. Edge functions respond**
For each deployed function, an OPTIONS preflight + an unauthenticated GET/POST. Pass =
any structured HTTP response that is **not** 404/5xx (401/403/400 are fine — the function
booted). This catches missing deploys, boot errors, and broken CORS allow-lists.
Functions with side effects (seed-*, send-*, sync-*, harvest*, *-poll, budget-sync,
group-audit) get preflight-only, never invoked.

**D. UI-data join**
Two end-to-end checks that DB rows actually reach the screen: `/projects` and
`/investigators` each render at least one grid row (AG Grid row or MobileCardList item).

## Where it lives

```text
e2e/
  smoke.spec.ts        pages load, no console errors
  data.spec.ts         tables have rows via REST
  functions.spec.ts    edge functions respond
  routes.ts            single shared list of routes (public / auth-gated)
playwright.config.ts   chromium only, 2 retries, baseURL from env
```

Playwright was removed earlier; this re-adds `@playwright/test` as a devDependency and
`npm run test:e2e`.

## How it runs in the workflow

New job **`5. Sandbox smoke QA`**, `needs: build-deploy`, in `.github/workflows/sandbox-qa.yml`:

1. Checkout, `npm install`, `npx playwright install --with-deps chromium`.
2. `BASE_URL` = `https://sandbox.brain-bbqs.org` when `deploy_pages` was true; otherwise it
   downloads the `sandbox-dist` artifact and serves it locally on `:4173`, so the suite also
   works on a build-only run.
3. Env: `SUPABASE_URL` / `SUPABASE_ANON_KEY` pointed at the **sandbox** project
   (`vzfsndsqveacpefoqwsu`, `SANDBOX_SUPABASE_ANON_KEY`) — never production.
4. A `deploy_pages` run waits for Pages to serve the new build (poll the site for the
   freshly built asset hash, up to ~3 min) before testing, so it never grades a stale deploy.
5. Results: a markdown table in `$GITHUB_STEP_SUMMARY` (route / table / function → pass·fail),
   plus the HTML report and failure screenshots uploaded as artifacts.
6. New input `run_smoke` (default true) to skip it, and `smoke_soft_fail` (default false) —
   when true the job reports but does not fail the run, useful for the first few passes.

## Notes

- Report-only artifacts stay out of git (`playwright-report/`, `test-results/` in `.gitignore`).
- The suite is generic on purpose: adding a route or table is one line in `routes.ts`.
- No production credentials are available to this job.
