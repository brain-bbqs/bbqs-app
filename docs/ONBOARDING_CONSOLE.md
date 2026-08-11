# Onboarding / Offboarding Admin Console (KG site)

A deterministic, form-driven admin subsystem on the KG site for member onboarding and
offboarding — the mechanical counterpart to the chat agent. The agent stays for
conversational and self-serve flows; this console is for admins/curators doing the
mechanical work with dropdowns and forms (no NLP, no tool-choice, no dead-ends).

## Principle — one shared state model
Both surfaces (agent + console) operate on the SAME KG state. The onboarding pipeline is
`investigators.onboarding_checklist` (jsonb) + `onboarding_completed_at` + live
`grant_investigators` membership. The console never re-implements orchestration — it
**writes columns and lets existing triggers do the work**:
- `trg_normalize_working_groups` canonicalizes WG tokens on write.
- `trg_sync_member_groups` provisions Google Groups when `role`/`working_groups` change.
- `auto_link_investigator` materializes `pending_role` into `user_roles` on first sign-in.
- `data_audit_log` (with `client_source`) records every write; console writes are tagged.

## Deterministic state model (source of truth — mirrors bbqs-agent checklist.ts)
- Persisted checklist keys: `kg_created`, `grant_link`, `consortium_group`, `pi_group`,
  `young_investigators_group`, `wg_groups`, `welcome_email`, `data_questionnaire`, `slack`.
  Meta (excluded from counts): `pre_check`, `status`, `offboarded_at`.
- Status values: `done | pending | not_started`.
- Optional steps (never cause "stuck"): `wg_groups`, `working_groups`.
- **Pipeline membership**: `onboarding_completed_at IS NULL` AND `checklist->>'pre_check' = 'done'`
  AND `checklist->>'status'` is not `'offboarded'` AND (`live_grant_count > 0` OR a non-meta
  step is `pending`/`queued`).
- **Stuck**: `days_since_created > 14` AND a required (non-meta, non-optional) step ≠ `done`.
- **Complete**: `onboarding_completed_at IS NOT NULL`.

## Backend contract
- **`onboarding_pipeline` view** (P1, this migration `20260806140000`) — `security_invoker`
  so `investigators` RLS gates it (admins/curators see all; a member sees only their own).
  Columns: id, name, email, role, working_groups, created_at, checklist, live_grant_count,
  days_since_created, steps_done, steps_total, is_stuck. The status panel reads this.
- **`onboard_member` RPC** (P2) — SECURITY DEFINER, gated to admin/curator: upsert the
  investigator (name, email, role, canonical working_groups, pending_role, institution),
  seed the role-appropriate checklist (`pre_check='done'` + steps `not_started`), optional
  grant-roster link. Groups provision via the sync trigger; returns the investigator id.
- **`offboard_member` RPC** (P3) — SECURITY DEFINER, gated: remove the leaving grant's
  roster row(s); on full departure (no remaining grants) set
  `onboarding_checklist = {status:'offboarded', offboarded_at:now}`, `onboarding_completed_at=null`.
  Multi-grant-safe (keeps access justified by a remaining grant). Distinct from the agent's
  "reset" (test teardown that deletes the record — NOT exposed here).
- **`send-welcome-email` edge function** (P2 follow-up) — role-templated welcome; the one
  capability not yet on the KG side (only access-approved/notify exist today).

## Pages (React, `src/components/admin/` + a tab in `AdminConsole`)
1. **Status panel** (P1) — `OnboardingPipelinePanel`: table over `onboarding_pipeline`, one
   row per in-flight member, a badge per stage (done/pending/not-started), progress,
   days-in-flight, stuck flag. Filters: all / in-progress / stuck. Polls every 60s. Gated to
   admin/curator (`useUserTier().isCurator`).
2. **Onboard wizard** (P2) — form: email, name, role dropdown, WG checkboxes, grant
   autocomplete, access tier → `onboard_member` → optional "send welcome email".
3. **Offboard wizard** (P3) — pick member + leaving grant → confirm → `offboard_member`.

## Status
- **P1 DONE** (commit f79e71c) — `onboarding_pipeline` view + status panel + Admin Console tab.
- **P2 DONE** — `onboard_member` + `set_onboarding_step` RPCs (`20260806150000`), `send-welcome-email`
  edge function, `OnboardMemberDialog` wizard (wired into the panel header), and the KG-site
  supabase client now tags writes `X-BBQS-Client: kg-site`.
- **P2.5 DONE (Smart fill)** — `parse-onboard` edge function (Lovable AI gateway,
  `google/gemini-2.5-flash`, admin/curator-gated, returns sanitized fields) + a "Smart fill"
  textarea in the wizard: paste a form row / email / description → LLM pre-fills the fields
  for the admin to review (feature-004: LLM proposes, human + deterministic path execute).
- **P4 DONE (interactive pipeline)** — migration `20260806160000`: `set_onboarding_step` accepts
  `skipped`; the view + rank treat skipped as complete; `onboard_member` gains `_secondary_emails`
  (written to `investigators.secondary_emails`). Panel: each pending/stuck stage is a click menu
  (**Mark done / Dismiss / Re-run**), and every member row has a one-click **Remind** button
  (`send-onboarding-reminder` emails the member their remaining steps). Wizard gains a
  **secondary email** field (+ Smart-fill fills it).
- **P6 DONE (resolve-for-real)** — every stage tag opens the resolver that fixes it:
  grant association (ranked live suggestions), working-group membership (writes
  `working_groups`, sync trigger provisions the lists), mailing-list re-sync, welcome email,
  and Slack channels. `data_questionnaire` is PI-only (migration `20260807140000`).
- **P7 DONE (Slack)** — `slack-channels` edge function: resolves a member by email
  (`users.lookupByEmail`), reads their channels, and adds the missing ones. Role rule mirrors
  the agent — everyone gets `SLACK_ONBOARDING_CHANNELS`; postdocs/grad students also get
  `SLACK_YI_CHANNELS`. Workspace ENTRY stays manual (Slack requires a guest invite); the
  function reports that explicitly rather than failing silently.
- **P3 DONE (offboarding)** — `offboard_member` RPC (migration `20260810120000`) + `OffboardMemberDialog`.
  Offboard = leave ONE grant, multi-grant-safe; the record is NEVER deleted (that is the agent's
  `reset`, deliberately not exposed). The RPC removes the roster row(s), computes what remains, and
  RETURNS the mailing lists no longer justified; the console then removes them via
  `group-audit action:'remove_groups'` as an explicit second confirmation, so an outward-facing
  action is never a hidden side effect of a DB call. On a FULL departure only, the record is marked
  `{status:'offboarded'}` and `onboarding_completed_at` cleared. Slack removal is not automated.

## RePORTER import stubs (migration `20260810130000`)
Importing a grant from NIH RePORTER creates `investigators` rows carrying only a **name** —
often with a doubled space, `"Firooz  Aflatouni"` — plus the `grant_investigators` roster row
with the correct PI role. **24 such email-less records hold roster rows**, so this is a class.
`onboard_member` upserts BY EMAIL, so onboarding one of those PIs used to either insert a twin
(roster row stays on the stub → the new record reads `live_grant_count = 0` and asks for a grant
forever) or fail `23505` on `investigators_name_key`. Confirmed on `1U01MH144347-01`, whose five
PIs are all stubs.

The RPC now reconciles first, matching an email-less record whose whitespace/case-normalized name
equals the typed name: **ADOPT** it (claim the row, set the email) or, when an emailed record also
exists, **MERGE** the stub into it. Ordering is load-bearing — every FK to `investigators.id` is
`ON DELETE CASCADE`, so repointing precedes the DELETE, and the rename follows the DELETE so the
name unique index cannot trip. The result carries `reconciled: 'adopted_stub' | 'merged_stub'` and
the wizard says so in its toast, so an admin can see WHICH record they wrote to. Adoption drops an
inherited `welcome_email: 'done'`: the legacy backfill marked **19 address-less records** complete,
and no welcome can have reached them.

Same migration: `onboarding_pipeline` counted checklist **metadata** as steps, because it
blacklisted key names and `source` (23 rows) / `finished_by_admin` (3 rows) were never listed —
each an unfinishable step that pinned the row to "stuck" with no action able to clear it. An entry
is now a step only when its **value is a status**; metadata is self-identifying, and a real step
always carries a status, so new steps can never be hidden.

## Role identity: which column is authoritative (issue #283, migrations 20260810130000 / 20260811120000)
Two columns, two jobs, and they are NOT interchangeable:

| column | meaning | vocabulary |
|---|---|---|
| `grant_investigators.role` | per-grant, RePORTER-derived — **the** authority for "role on this project" | canonical tokens only, enforced by `trg_normalize_grant_role` |
| `investigators.role` | one free-text consortium/career label (its UI placeholder: "e.g. Working Group Chair, Trainee, Steering Committee") | human labels; never a machine token |

A scalar cannot express a role that varies per grant, so `investigators.role` is not a project role.
**`pi@` entitlement derives from the ROSTER**; career stage (`young-investigators@`) derives from the
label, and by SUBSTRING — exact matching against raw form labels is what once flagged 66 real
trainees as removable.

Why it mattered: `sync-member-groups` decided `pi@` by exact-matching `investigators.role`. Measured
2026-08-11 — 74 investigators held a PI role on the roster, 9 had a canonical token in
`investigators.role`, so the trigger **missed 65 real PIs**, and the 9 it caught were exactly those
`onboard_member` had written a token for. `group-audit` computed the expected set from the roster, so
the two surfaces disagreed and the audit reported drift no repair could settle.

The vocabulary backfill runs with `trg_sync_member_groups` DISABLED: normalizing stored vocabulary is
not a membership change and must not emit one. Guarded by
`tests/guards/role-vocabulary-parity.test.mjs`, proven red (3 failures) against the pre-fix code.

## Slack channel map (source of truth)
Membership = everyone-channel + young-investigator channel (postdoc/graduate_student) + one
channel per working group the member belongs to. Kept in KG project secrets:

| Scope | Channel | ID | Secret |
|---|---|---|---|
| Everyone | `#general` | `C07UA8763SA` | `SLACK_ONBOARDING_CHANNELS` |
| Postdocs / grad students / trainees | `#younginvestigators` | `C09673P9D1A` | `SLACK_YI_CHANNELS` |
| WG-Analytics | `#bbqs-wg-analytics` | `C0BP1AN59CZ` | `SLACK_WG_CHANNELS` |
| WG-Devices | `#bbqs-wg-devices` | `C09633EE5M5` | `SLACK_WG_CHANNELS` |
| WG-ELSI | `#bbqs-wg-elsi` | `C098CRMDFUK` | `SLACK_WG_CHANNELS` |
| WG-Standards | `#bbqs-wg-standards` | `C097J7SLNJY` | `SLACK_WG_CHANNELS` |

`trg_sync_slack_channels` (migration `20260807220000`) keeps these in step automatically on any
INSERT/UPDATE of `role`/`working_groups`, from any surface. The bot must be a member of each
channel (`/invite @BBQS`) — it can self-join PUBLIC channels only, and only with the
`channels:join` scope. NOTE: the everyone/YI/WG lists ALSO exist agent-side in
`consortium_settings` (`slack_onboarding_channels`, `slack_young_investigator_channels`); keep
them in sync or the two surfaces will invite people differently.

## Manual apply / config (KG side)
- Apply migrations in the SQL editor (in order): `20260806120000`, `20260806130000`, `20260806140000`, `20260806150000`, `20260806160000`.
- Deploy edge functions (keys already on the project): `parse-onboard` (LOVABLE_API_KEY),
  `send-welcome-email` + `send-onboarding-reminder` (RESEND_API_KEY):
  `supabase functions deploy parse-onboard send-welcome-email send-onboarding-reminder slack-channels`
- Slack secrets on the KG project (option A — the bot token is duplicated here from the agent):
  `supabase secrets set SLACK_BOT_TOKEN=xoxb-… SLACK_ONBOARDING_CHANNELS="C07UA8763SA,C0951JD5SAV,C096Q1GMU01,C07UGPTGCHH" SLACK_YI_CHANNELS="C09673P9D1A"`
  Bot scopes needed: `users:read.email`, `channels:read`, `groups:read`, and invite rights
  (`channels:manage` / `groups:write`). Keep `slack_young_investigator_channels` in the AGENT's
  consortium_settings set to the SAME value (`C09673P9D1A`) so both surfaces agree.
