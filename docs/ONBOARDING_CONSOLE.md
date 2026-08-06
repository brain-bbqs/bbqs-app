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
- P1 view + status panel: THIS change.
- P2/P3 RPCs + wizards + welcome-email fn: next, continuous.
