# Retiring Lovable from the BBQS site

Goal: the site builds, deploys, authenticates and runs its AI features with no Lovable
service in the path. Changes reach production only through the GitHub review + QA gate.

## What Lovable still touches

1. **Build** — `vite.config.ts` loads the `lovable-tagger` plugin; `package.json` depends on it.
2. **AI features** — 8 backend functions call Lovable's AI gateway with a Lovable-issued key:
   assistant router, discovery chat, cohort summary, two grant-method harvesters, onboarding
   parser, state-privacy scan, plus the shared security helper.
3. **Billing** — `budget-sync` and three admin panels read Lovable invoice/credit/usage tables.
4. **Hosting references** — `bbqs-app.lovable.app` in the sign-in allow-list and the approval
   email link; preview-host detection in the app; the gateway host in the page security policy.
5. **Editing** — Lovable pushes commits to `dev` between sessions.

Deployment itself is already independent: GitHub Pages serves `brain-bbqs.org` from `main`.

## Plan

**Step 1 — cut the build dependency**
Remove the tagger plugin from the build config and the dependency list. No visible change.

**Step 2 — move AI off the Lovable gateway**
Point all eight functions at OpenRouter (the same provider the agent repo already uses),
behind one shared helper so there is a single place to change providers. Add the OpenRouter
key as a project secret; keep the Lovable key working until the switch is verified, then remove
it. Test each function's live response before removing the old path.

**Step 3 — retire billing**
Stop the budget sync job, hide the three Lovable billing panels from the admin console, and
archive the invoice/credit/usage tables (kept read-only for the record, dropped once the
billing relationship formally ends).

**Step 4 — repoint hosting references**
Replace `bbqs-app.lovable.app` with `brain-bbqs.org` (and `sandbox.brain-bbqs.org`) in the
sign-in allow-list, the approval email link, and the page security policy. Drop the
Lovable preview-host detection. This is the one step that can break sign-in, so it ships
with the guard test that already checks these allow-lists.

**Step 5 — make GitHub the only way in**
Protect `dev` and `main` so every change arrives as a reviewed pull request; production
deploys only after Sandbox QA passes. Remove the Lovable write access to the repo last, once
steps 1–4 are merged and the site is verified.

**Step 6 — documentation**
Update the working agreement and README to describe the GitHub-only process, and record the
change as a spec entry in the agent repo.

## Order and risk

Steps 1 and 3 are safe any time. Step 2 is the largest and should be verified function by
function. Step 4 is the risky one — sign-in breaks if the allow-list and the served domain
disagree, so it happens right before Step 5, never after Lovable access is gone.

## Open questions

- Confirm OpenRouter as the AI provider for all eight functions (vs. direct vendor keys, or
  turning some features off).
- Keep the Lovable billing history visible read-only, or delete it outright.
- Whether the Claude agent repo should keep opening pull requests after the cutover.
