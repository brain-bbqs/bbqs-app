# BBQS Knowledge Graph site — Working Agreement

This repo is the **KG site** (React/Vite + Supabase, deployed by Lovable). It is one half of a
two-repo system; the other is **`../bbqs-agent`** (the chat agent). They share one Supabase project
(`vpexxhfpvghlejljwpvt`), one constitution, and one set of specs.

## Why this file exists

It did not, until 2026-08-11, and its absence had a measurable cost. The Spec-Driven Development
protocol — the `[debug]` routine, the standard work loop, "resolve the active feature from
`.specify/feature.json`" — lived only in `bbqs-agent/CLAUDE.md`. Working *here*, there was no working
agreement, no `feature.json` to resolve, no `specs/`, no `tasks.md`, no `qa-itinerary.md`. So the
reasoning behind changes went into commit messages instead of spec artifacts, and issue #283 (role
identity had no single source of truth) was found, diagnosed and fixed with **no** issue, spec
amendment or QA row until asked about it directly.

Worse, the constitution copy here was a **stale fork** — v1.5.0 while the agent's had reached v1.7.0.
Two copies of a shared rulebook drift; one of them is then wrong.

## The constitution is NOT in this repo

**Authoritative: `../bbqs-agent/.specify/memory/constitution.md`.** `.specify/memory/constitution.md`
here is a pointer stub, deliberately not a copy — see the note inside it. Read the real one.

All eleven principles bind changes made here. Two are load-bearing in this repo specifically:

- **III. Live State Is the Source of Truth** — decide from the system of record (Google Group
  membership, Forms responses, **grant roster**), never a cached flag. This is the principle #283
  broke: `pi@` entitlement was computed from the free-text `investigators.role` instead of
  `grant_investigators`, so the trigger missed 65 of 74 real PIs.
- **X. Full Data Provenance** — every write is captured by `log_data_change` into `data_audit_log`.
  Service-role and SQL-editor writes have no `auth.uid()`, so they MUST name themselves:
  `SELECT public.set_actor('migration:<name>')` / `set_actor('<function-name>')` as the first
  statement. Without it, 78% of audit rows record *what* changed and not *who*.

## Specs live in the agent repo

Active feature: `../bbqs-agent/.specify/feature.json` → `../bbqs-agent/specs/<NNN-feature>/`.
A change made **here** still gets its `spec.md`/`plan.md`/`tasks.md`/`qa-itinerary.md` entry **there**.
There is deliberately no second `specs/` tree: one spec home, two implementation repos.

## The debug protocol applies here in full

`../bbqs-agent/CLAUDE.md` holds the routine; it is not agent-specific. In particular:

- **Evidence before cause.** No naming a cause without a tool result showing the literal error in the
  same turn. A hypothesis you emitted earlier is not evidence.
- **Bug-shaped input is the trigger**, not the literal `[debug]:` token. A six-word report ("still
  broken") gets step 1, not a guess.
- **Trace the blast radius in both directions before editing a shared layer.** In this repo the
  shared layers that bite are: the supabase client config (a global header once broke every edge
  function's CORS preflight), RLS policies, `CREATE OR REPLACE VIEW` (cannot drop or reorder columns
  — 42P16), and any role/vocabulary constant duplicated across surfaces.
- **Prefer a mechanical guard over vigilance.** `npm run test:guards` — zero-dependency Node tests
  that encode cross-layer invariants. Every breakage this session landed where no machine was
  checking. Add a guard when you fix a class; prove it RED first.

## Repo-specific conventions

- **Branch `dev`.** Lovable deploys from it and pushes to it between sessions, so `git pull` before
  editing and expect to rebase before pushing. `main` receives `dev` via PR.
- **Migrations are applied MANUALLY** in the Supabase SQL editor for `vpexxhfpvghlejljwpvt`; they are
  never `db push`ed. Deliver them to the user as a PowerShell clipboard command, not a repo path:
  `Get-Content "<abs path>.sql" -Raw | Set-Clipboard`. Long SQL inline is a last resort.
- **Edge functions** deploy per-function: `supabase functions deploy <name> --project-ref
  vpexxhfpvghlejljwpvt`. Each has a HAND-WRITTEN CORS allow-list — `tests/guards/cors-header-parity`
  exists because that is easy to get wrong.
- **Gates before pushing:** `npx tsc --noEmit` and `npm run test:guards`.
- **Never commit build artifacts** — `playwright-report/`, `test-results/` (PR #191 did).
- Code must degrade gracefully when a migration has not been applied yet: a missing table or column
  should downgrade a feature, not error the page.

## Two role columns — do not conflate them (issue #283)

| column | meaning | vocabulary |
|---|---|---|
| `grant_investigators.role` | per-grant, RePORTER-derived; **the** authority for "role on this project" | canonical tokens only (`trg_normalize_grant_role` enforces) |
| `investigators.role` | one free-text consortium/career label | human labels; never a machine token |

A scalar cannot express a role that varies per grant. `pi@` derives from the roster; career stage
(`young-investigators@`) derives from the label and matches by **substring**, because that column
holds raw Google-Form labels — exact matching once flagged 66 real trainees as removable.
