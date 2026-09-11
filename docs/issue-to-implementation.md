# Issue → Implementation: the governance model

This repo can turn an issue into a merged change with very little human effort — but only in
proportion to how far the change reaches. The amount of gate a change gets is decided by a
**deterministic classifier**, not by anyone's judgment in the moment and not by anything the issue
says about itself.

Spec: `bbqs-agent/specs/013-issue-to-implementation/`.

## The two dimensions

Every bot PR is scored on:

- **Blast radius** — which shared layers the diff touches. The list is the one CLAUDE.md already calls
  "the layers that bite": migrations, RLS, views, auth, the Supabase client, shared edge code, role
  vocabulary, CI, dependencies, the deploy domain. These are the changes that have broken production
  from a small-looking diff.
- **Complexity** — size ceilings (files, lines, new files).

## The three classes

| Class | Label | What it is | Gate |
|-------|-------|------------|------|
| **A** | `auto:A` | trivial + low blast (docs, copy, one leaf component; within size limits; no shared layer) | **one approving review** from the dev/admin team → auto-merge to `dev` once checks are green |
| **B** | `review:B` | normal app logic, no danger layer | normal human review before merge to `dev` |
| **C** | `spec:C` | touches any danger layer | **Spec Kit** artifacts + Constitution Check + a human `spec-signoff`; **never auto-merges** |

`main` is never written automatically by any class. Production is reached only through a human
`dev`→`main` PR and the `sandbox-qa.yml` workflow.

## Why the gate is deterministic

Constitution Principle II: the LLM implements, but it does not get to decide how much scrutiny its own
change receives. The class is computed by `scripts/triage/classify.mjs` from the **diff** — so a
prompt-injected issue cannot talk its way into a lighter gate, and the classifier file itself is a
Class-C path (it can't be weakened through the light path).

## Who can trigger automatic implementation

Only **trusted** issues auto-implement:

- **`from-site`** — filed by an authenticated user through the website (the `create-github-issue` edge
  function requires a signed-in JWT and applies this label server-side; an outsider cannot forge it).
- **a repo collaborator/member/owner** opened the issue directly.
- **`claude-go`** — a maintainer explicitly authorized a run.

Anything else is **triaged but not implemented** until a maintainer adds `claude-go`. The issue body is
untrusted input; the trust decision is made from GitHub metadata only.

## The pieces

- `scripts/triage/classify.mjs` — the classifier (pure, dependency-free) + CLI.
- `tests/triage/classify.test.mjs` — pins the guarantees (danger→C; no self-approval; size ceilings).
- `.github/workflows/triage.yml` — classify, label, post the attribution comment, hold Class C.
- `.github/workflows/verify.yml` — typecheck + build + guards + triage tests (the green gate).
- `.github/workflows/class-a-automerge.yml` — one approval → re-classify → enable auto-merge.
- `.github/workflows/claude-issue-handler.yml` — trust gate + machine-authored PRs.
- `supabase/functions/create-github-issue/index.ts` — `from-site` + server-stamped filer id.

## One-time setup (repo settings — a human must do this)

The workflows are inert until these are configured; the auto-merge job comments if they are missing.

1. **Settings → General → Pull Requests**: enable **Allow auto-merge** and **Automatically delete
   head branches** (protected branches like `dev`/`main` are never auto-deleted, so this only cleans
   up merged topic branches).
2. **Settings → Branches → Branch protection rule** for `dev`:
   - Require a pull request before merging. **Leave "Require approvals" unchecked (0)** — a solo
     maintainer cannot approve their own PR, and the deterministic checks below are the real gate.
     Keep the *rule itself* in place even at 0 approvals: its existence is what marks `dev` as
     protected, which is what exempts it from auto-delete on a `dev→main` merge.
   - Require status checks to pass: **`verify`**, **`guards`**, **`triage/class`**, **`classify`**.
     **Do NOT require `triage/spec-gate`** — see the note below.
3. `main` is currently unprotected. Production is reached only through a **manual `dev→main` PR**
   (which triggers `publish.yml`); that human step is the production gate.

### `triage/spec-gate` is advisory on `dev`, by design

The classifier still labels every Class-C PR `spec:C` and posts the blast-radius attribution comment,
so a danger-layer change is always **visible**. But `triage/spec-gate` is deliberately kept **out of
`dev`'s required checks**, because the real Class-C block lives elsewhere:

- **The bot cannot auto-merge Class C regardless.** `class-a-automerge.yml` re-classifies on approval
  and enables auto-merge *only* for Class A; a bot Class-C PR just waits for a human. So requiring
  spec-gate adds no protection against the pipeline.
- **Requiring it only blocks the human maintainer.** A solo maintainer's own legitimate danger-layer
  PRs (a workflow edit, a migration) would be held pending a `spec-signoff` label they'd add to
  themselves — friction with no second reviewer. So the gate is advisory here.

If a second reviewer joins and you re-add `triage/spec-gate` to the required checks, the **`spec-signoff`
label is the one-click release** for a Class-C PR — and unlike the "merge without waiting for
requirements" bypass, it keeps `verify`/`guards` enforced instead of skipping everything.

## Deploy

```bash
supabase functions deploy create-github-issue --project-ref vpexxhfpvghlejljwpvt
```

## Tuning the classifier

Edit `DANGER_RULES` (path → layer + severity) and `THRESHOLDS` (Class-A ceilings) in
`scripts/triage/classify.mjs`. That file is itself a Class-C path, so any change to the gate goes
through the full gate — by design.
