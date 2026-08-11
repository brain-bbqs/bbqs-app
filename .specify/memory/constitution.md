# BBQS Constitution — pointer, not a copy

**The authoritative constitution lives in the agent repo:**

```
../bbqs-agent/.specify/memory/constitution.md
```

Read it there. Do not reintroduce a copy here.

## Why this is a stub

This file used to hold a full duplicate of the constitution. On 2026-08-11 it was found pinned at
**v1.5.0** (ratified 2026-05-29, last amended 2026-06-19) while the agent's copy had reached
**v1.7.0** — a stale fork roughly two months behind, containing an older Principle X and missing
later amendments.

That is the predictable failure of two copies of one rulebook: they drift, and then one of them is
silently wrong while still looking authoritative. Since both repos are always checked out side by
side (`bbqs-agent` and `brain-bbq-clone`), a relative pointer costs nothing and cannot go stale.

The ten principles bind changes in this repo exactly as they do in the agent repo. Two matter most
here, and both were broken in ways this stub is meant to prevent:

- **III. Live State Is the Source of Truth** — issue #283: `pi@` entitlement was computed from the
  free-text `investigators.role` rather than the `grant_investigators` roster, which Principle III
  names explicitly as the system of record. The trigger missed 65 of 74 real PIs.
- **X. Full Data Provenance** — writes without `auth.uid()` (service role, SQL editor, migrations)
  must call `public.set_actor(...)` or the audit trail records what changed and not who. 78% of
  existing rows have a NULL actor.

See `../brain-bbq-clone/CLAUDE.md` for this repo's working agreement, and
`../bbqs-agent/.specify/feature.json` for the active feature whose spec artifacts a change here
should update.
