---
id: welcome-new-team
purpose: Welcome email to the PIs of a newly awarded BBQS grant
sent_by: DCAIC admin (dcaic-admin@brain-bbqs.org)
audience: All PIs/MPIs on one award, addressed together
links_verified: 2026-08-31
variables:
  - PI_FIRST_NAMES      # "Markus, Pietro, Ueli and Yisong" — Oxford-less, contact PI first
  - GRANT_NUMBER        # R61MH142354
  - PROJECT_TITLE       # optional; use when the award title is known
  - ROSTER_DEADLINE     # send date + 2 weeks, written "17 September"
  - QUESTIONNAIRE_DEADLINE  # ROSTER_DEADLINE + 1 week
  - SENDER_FIRST_NAME   # Nader
---

# Welcome email — new BBQS team

## Recipients

**To** — every PI/MPI on the award, in one email, contact PI first. Not one email each: they are
co-leads of one project, and separate emails invite duplicate rosters.

**CC — standing, every send.** The award notice comes from NIH and the program officers track
whether the team was actually onboarded, so they stay on the thread.

| | |
|---|---|
| `holly.moore@nih.gov` | Holly Moore, NIH/NIDA |
| `dana.schloesser@nih.gov` | Dana Schloesser, NIH/OD |
| `lizzy.ankudowich@nih.gov` | Elizabeth Ankudowich, NIH/NIMH — BBQS Co-Lead |
| `satra@mit.edu` | Satrajit Ghosh, MIT |
| `dcaic-admin@brain-bbqs.org` | DCAIC admin list — archives the thread |

## Links (single source of truth)

Edit them here, not in the body. Status is from `curl -L`, 2026-08-31.

| Purpose | URL | Status |
|---|---|---|
| Consortium site | `https://brain-bbqs.org/` | 200 |
| Working groups | `https://brain-bbqs.org/working-groups` | SPA route |
| Profile / WG selection | `https://brain-bbqs.org/profile` | SPA route |
| Onboarding form (alt to profile) | `https://docs.google.com/forms/d/e/1FAIpQLSc6_ueJUuqcKzkJ2-waBv3o8UsVYoOepJWMEpyjYiZNvcGPbQ/viewform` | 200 |
| Data questionnaire | `https://forms.gle/7JUR5xR9iVgFm41P7` | 200 |
| Key links quick reference | `https://docs.google.com/document/d/1cCSTtjCJQLyPyqz10HFf-c1oOIhIiyx8oo46S27xw3M/edit?usp=drive_link` | 200 |
| EMBER archive | `https://emberarchive.org/` | 200 |
| EMBER documentation | `https://docs.emberarchive.org` | 200 |
| BBQS assistant | `https://agent.brain-bbqs.org` | 200 |
| Contact | `dcaic-admin@brain-bbqs.org` | — |

**SPA route** = the site is a single-page app on GitHub Pages, so a deep link returns HTTP 404 and
`public/404.html` redirects the browser to the right view. Fine for a person clicking from email;
do not use these two in anything that checks status codes.

**`emberarchive.org/documentation` is dead** (404) and was in the version of this email sent to the
previous cohort. The documentation lives at `docs.emberarchive.org`.

**`agent.brain-bbqs.org`** points at Lovable's hosting today. It moves during the Lovable phase-out;
re-verify before each send.

---

## Body

> Dear {{PI_FIRST_NAMES}} — congratulations, and welcome to BBQS! We look forward to working with you.
>
> The consortium website — https://brain-bbqs.org/ — has the shared calendar, the BBQS projects, and
> the [working groups](https://brain-bbqs.org/working-groups) (WGs). We'd encourage you and your team
> to take part.
>
> **What we need from you (by {{ROSTER_DEADLINE}})**
>
> 1. **Get your team on the roster** — either way works:
>    - **Send us a list.** Reply with one line per person: `Full Name <email> — role` (postdoc, grad
>      student, research staff, …) and we'll onboard everyone at once.
>    - **Have them sign themselves up** at https://brain-bbqs.org/. Anyone not yet on the roster is
>      routed to a short access request — ask them to enter your name or your grant number
>      ({{GRANT_NUMBER}}) so we place them on the right project. We approve from our side.
> 2. **Complete your own profile**, and ask your team to do the same, at
>    https://brain-bbqs.org/profile — ORCID, institution, research areas, skills, and the working
>    groups you'd like to join. Selecting WGs there is what gets each person onto the matching
>    mailing lists. (The [onboarding form](https://docs.google.com/forms/d/e/1FAIpQLSc6_ueJUuqcKzkJ2-waBv3o8UsVYoOepJWMEpyjYiZNvcGPbQ/viewform)
>    works too — same result.)
> 3. **Data questionnaire (by {{QUESTIONNAIRE_DEADLINE}})** — please complete the
>    [data questionnaire](https://forms.gle/7JUR5xR9iVgFm41P7) for your project. It helps EMBER and
>    the DCAIC understand your technical needs. You're welcome to delegate the drafting, but we ask
>    the PI to own the submission, since it describes the project's data plan.
>
> **What happens once your team is on the roster** — they're added to the relevant Google Groups and
> the consortium Google Drive folders, and get this quick reference of key
> [links](https://docs.google.com/document/d/1cCSTtjCJQLyPyqz10HFf-c1oOIhIiyx8oo46S27xw3M/edit?usp=drive_link).
> Tell us if you'd also like them on Slack.
>
> **Data sharing runs through EMBER** — https://emberarchive.org/
> ([documentation](https://docs.emberarchive.org)).
>
> **BBQS assistant (beta)** — we also run an assistant at https://agent.brain-bbqs.org; sign in with
> your institutional login via Globus. It can look up your grant and project, tell you what's still
> outstanding ("what are my remaining onboarding steps?"), and answer questions about the consortium,
> projects, tools, and data standards. It's early and still improving, so if anything looks wrong,
> email us and we'll sort it out directly.
>
> Any questions, just reach us at [dcaic-admin@brain-bbqs.org](mailto:dcaic-admin@brain-bbqs.org).
>
> Sincerely,
> {{SENDER_FIRST_NAME}} — on behalf of the DCAIC

---

## Notes for whoever sends it

**Deadlines are relative, not fixed.** The previous send hardcoded "17 August" and "24 August"; by
the time this file was written those had passed. Compute `ROSTER_DEADLINE` as send date + 2 weeks and
`QUESTIONNAIRE_DEADLINE` as one week after that.

**Slack is opt-in and partly manual.** Workspace entry for an external guest cannot be automated —
Slack requires a human guest invite. Channel adds after that are automated (`slack-channels`). Hence
"tell us if you'd also like them on Slack" rather than promising it.

**Check the CC list against the NIH introduction for this award.** The standing list above covers the
BBQS program officers, but an award's own introduction may add someone — R61MH142354's also went to
Brock Wester (brock.wester@jhuapl.edu, EMBER) and Jyl Boline. Add per-award recipients on top of the
standing list rather than editing it.

**Not covered by this template**, and usually needed alongside it for a new award: the DCAIC meeting
invitation, and notifying PI Committee leadership that a new team needs cross-group representation —
both were explicitly requested in the NIH introduction for R61MH142354.

**Before sending, check** that the people are on the roster with a PI-grade role, or the mailing-list
entitlement the email promises will not exist yet. `pi@` derives from `grant_investigators`, not from
`investigators.role` (issue #283).
