# Onboarding a new award, end to end

The ordered sequence for putting a newly awarded team into the consortium. Written from doing
R61MH142354 on 2026-08-31, and intended as the spec for an MCP tool that runs it.

**The reason this document exists:** no single path does onboarding. It spans a SQL migration, an
edge function only a signed-in admin can call, two that a cron can call, and two steps nothing
automates. Every step is easy; the order and the gaps are what nobody can hold in their head.

## The ordering constraints that actually bite

- **Roster before groups.** `sync-member-groups` decides `pi@` with `isRosterPi()`, which reads
  `grant_investigators` — not `investigators.role` (issue #283). Sync before the roster row exists
  and it silently adds `consortium@` only, reports success, and nobody notices.
- **Groups and Drive before the welcome email.** The email states the person has been added to both.
- **Slack `check` before `invite`.** External guests must be invited to the workspace by a human
  first; `check` reports `not_in_workspace` rather than failing.
- **A new record records no provenance unless the writer declared a source class**
  (`set_source_class()` / `x-bbqs-source-class`). See `20260831160000`.

## Auth — the thing that decides the MCP design

| Callable by | Functions |
|---|---|
| Signed-in admin/curator JWT only | `group-audit`, and every `SECURITY DEFINER` RPC (`onboard_member`, `set_onboarding_step`, `offboard_member`) — they gate on `auth.uid()` |
| Service role, via `cron_invoke` | `import-grant-publications`, `reporter-pi-sync` |

An MCP server carrying **the curator's own session** satisfies both columns and needs no service-role
key. That is the cleanest resolution: the RPCs then attribute writes to a real person, which is what
Constitution X wants, instead of an unattributed service-role write.

`cron_invoke` reads `project_service_role_key` from the vault and **silently falls back to the anon
key** if it is missing or malformed — it tests the shape of a JWT, not its role. That slot held the
anon key until 2026-08-31, so every service-role-gated function driven from SQL returned 401 with no
trace. Check it before blaming a function.

## The sequence

### 1. Establish the award and the roster — `kg_created`, `grant_link`

If NIH RePORTER has the grant: `add-project-by-grant`, or `onboard_member` per person with
`_grant_id`.

If it does not (a funder award notice arrives months earlier): a migration, as in
`20260831120000`. Declare `funder_notice` as the source class, and set `role_source =
'funder_notice'` on the roster rows so a later `reporter_pi_drift` treats the registry as
*confirming* rather than conflicting.

Do **not** call `onboard_member` from the SQL editor — it gates on `auth.uid()`, which is NULL there.

Also create the `projects` row and the `organizations` link. The Projects page reads institution
from the **contact PI's** `investigator_organizations` entry; the scalar `investigators.institution`
feeds the People directory only. Setting one and not the other shows an institution on one page and
"Unknown" on the other.

### 2. Mailing lists — `consortium_group`, `pi_group`, `wg_groups`

One call covers all of them. `old` is deliberately empty so the delta is "add everything"; the
function is additive and never removes.

```jsonc
// POST sync-member-groups
{ "email": "...", "old": { "working_groups": [], "role": null },
  "new": { "working_groups": [], "role": "Principal Investigator (PI)" } }
```

`trg_sync_member_groups` does this automatically on UPDATE of `role`/`working_groups` — but it is
**AFTER UPDATE**, so a person created by INSERT is never synced. That is what `group-audit` exists
for: `{"action":"audit"}` diffs live Google membership against the KG and writes nothing;
`{"action":"repair"}` adds the missing. Audit first, always.

Then `set_onboarding_step(id, 'consortium_group', 'done')` and the same for `pi_group`.

### 3. Google Drive — **not automated**

No function in this repo touches the Drive API. Add the team to the consortium folders by hand.
The welcome email promises this, so it must happen before step 5.

### 4. Data questionnaire — `data_questionnaire`

PI-only (`role_owns_questionnaire`). Cannot be automated; the PI submits it. `send-onboarding-reminder`
emails whoever still has steps outstanding.

### 5. Welcome email — `welcome_email`

Template, links and the standing NIH cc list: [`templates/welcome-new-team.md`](templates/welcome-new-team.md).

```jsonc
// POST send-welcome-email
{ "to": "...", "name": "...", "role": "Principal Investigator (PI)" }
```

One email per **award**, addressed to all PIs together, contact PI first — not one each.

### 6. Slack — `slack`

```jsonc
// POST slack-channels
{ "email": "...", "role": "...", "working_groups": [], "action": "check" }   // then "invite"
```

`check` reports `not_in_workspace`; workspace entry for an external guest is a manual Slack guest
invite. `invite` adds the configured channels once they exist in the workspace. Ask first — the
welcome email offers Slack rather than assuming it.

## Verify — the panel for in-flight, the audit for drift

Two surfaces, and reaching for the wrong one wastes a Google round-trip and answers a question you
did not ask.

- **`onboarding_pipeline` panel** — people who have not finished. Membership requires
  `onboarding_completed_at IS NULL`, so a new team appears the moment the roster lands and shows
  n/7. This is the surface for a fresh onboarding.
- **`group-audit`** — people who finished and have since drifted, and addresses in a group that no
  roster explains. It reads live Google, so it is slower and answers about everyone.

A brand-new team is not drift, it is unfinished. Running the audit against one before its rows exist
returns nothing and looks like a bug: on 2026-08-31 the audit reported `pi@` expected 75, missing 0,
which is 71 PIs with primary addresses plus the four new MPIs — correct, and only after the rows
were there to be expected.

Reading the audit table: `In Google` minus `Expected` is NOT drift. `expected` is built from primary
addresses only while a secondary satisfies membership, so anyone in a group under an alias inflates
`in_google` without appearing in `expected`. `consortium@` read 302 vs 242 with just 10 unentitled.
`missing` and the unentitled list are the columns that mean something.

A step marked `done` is a claim that the outward action happened — so mark it from the resolver that
performs the action, never by hand, or the checklist becomes the same silent-failure record that
`group-audit` was written to catch.

```sql
SELECT name, email, steps_done, steps_total, is_stuck, checklist
  FROM public.onboarding_pipeline
 ORDER BY name;
```
