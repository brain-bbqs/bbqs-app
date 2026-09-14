# Disconnecting Lovable from the BBQS site

This document describes how to remove Lovable as a runtime, build, and editing dependency for the BBQS website. After these steps are complete, the site will build, deploy, authenticate, and run its AI features without any Lovable service in the path. All changes will reach production only through the GitHub review and QA approval process.

## Current Lovable touchpoints

1. **Build dependency** — `vite.config.ts` loads the `lovable-tagger` plugin, and `package.json` lists it as a dependency.
2. **AI gateway** — Eight backend edge functions call Lovable's AI gateway using a Lovable-issued key:
   - `assistant-router`
   - `discovery-chat`
   - `cohort-mental-model-summary`
   - `harvest-grant-methods`
   - `harvest-grant-methods-multihop`
   - `parse-onboard`
   - `state-privacy-scan`
   - `security.ts` shared helper
3. **Billing data** — `budget-sync` and three admin panels read Lovable invoice, credit, and usage tables.
4. **Hosting references** — `bbqs-app.lovable.app` is still used in the Globus sign-in allow-list, the access-approval email link, the page Content-Security-Policy, and preview-host detection.
5. **Editing access** — Lovable pushes commits directly to the `dev` branch between sessions.

Deployment is already independent: GitHub Pages serves `brain-bbqs.org` from the `main` branch.

## Disconnection steps

### Step 1 — Remove the build dependency
- Delete the `lovable-tagger` import and plugin from `vite.config.ts`.
- Remove `lovable-tagger` from `package.json`.
- Run `npm install` and verify the site still builds and the guard tests pass.

### Step 2 — Move AI off the Lovable gateway
- Create a shared OpenRouter helper in `supabase/functions/_shared/ai.ts` to replace the Lovable gateway helper.
- Update the eight functions listed above to call OpenRouter instead of `ai.gateway.lovable.dev`.
- Add `OPENROUTER_API_KEY` as a project secret.
- Keep `LOVABLE_API_KEY` available until every function is verified, then delete the secret and remove the old helper.
- Test each function's live response before removing the fallback path.

### Step 3 — Retire Lovable billing
- Stop the `budget-sync` edge function from running (remove its cron trigger or disable the function).
- Hide the Lovable invoice, credit, and usage panels from the admin console.
- Archive the `lovable_invoices`, `lovable_user_usage`, and `lovable_credit_events` tables as read-only.
- Drop the tables once the billing relationship is formally ended.

### Step 4 — Repoint hosting references
- Replace `bbqs-app.lovable.app` with `brain-bbqs.org` (and `sandbox.brain-bbqs.org`) in:
  - `supabase/functions/globus-auth/index.ts`
  - `supabase/functions/_shared/auth.ts`
  - `supabase/functions/send-access-approved-email/index.ts`
  - `index.html` Content-Security-Policy
  - `src/lib/preview-mode.ts`
- Remove Lovable preview-host detection from the app.
- This is the highest-risk step because sign-in will break if the allow-list and served domain disagree. Ship it with the existing CORS allow-list guard test.

### Step 5 — Make GitHub the only editing path
- Require pull-request review for `dev` and `main`.
- Keep production deploys gated by the Sandbox QA workflow.
- Revoke Lovable's write access to the repository after steps 1–4 are merged and verified.

### Step 6 — Update documentation
- Update `CLAUDE.md` and the README to describe the GitHub-only contribution and deploy flow.
- Record this change as a spec entry in the `../bbqs-agent` repository.

## Execution order and risk

- Steps 1 and 3 can happen anytime and are low risk.
- Step 2 is the largest; verify function by function.
- Step 4 is the riskiest and must happen before Step 5.
- Step 5 should happen only after the site is verified without Lovable services.

## Open decisions

- Confirm OpenRouter as the replacement AI provider for all eight functions, or choose direct vendor keys / feature shutdown for some.
- Decide whether to keep Lovable billing history visible read-only or delete it outright.
- Confirm whether the Claude agent repo should continue opening pull requests after the cutover.
