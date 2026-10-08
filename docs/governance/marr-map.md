# Marr map — BBQS as a social information-processing system

Seed document, first iteration. Frames the consortium with Marr's levels of analysis extended for
social systems (Krafft et al., "Marr's levels for social systems", arXiv:1301.3836) so that each
feature states which group-level problem it solves, for whom, and how a failure would be noticed.

> Spec home is `../bbqs-agent/specs/` (see CLAUDE.md). This file is a seed there to adopt;
> move it, don't fork it.

## Levels

| Level | Question | BBQS instance |
|---|---|---|
| Normative (added) | Whose problem is it, who bears the cost? | Benefit: PIs, trainees, NIH, public. Cost: labs doing curation. |
| Computational | What group problem is being solved? | Coordinate heterogeneous labs on shared vocabularies and discoverable data (endogenous: it exists because labs are differentiated). |
| Algorithmic | How is it solved? | Working groups propose terms, adopt schema, register datasets, resolve conflicts. |
| Representation (added) | What shared data structure does it run over? | LinkML schema, grant roster, canonical role tokens. |
| Implementation | What makes it run? | Supabase, Google Groups, edge functions, this site. |
| Deviance (added) | How do we notice it failing? | See below. |

## Deviance = "line-cutting"

An algorithm is only correct if its invariant holds. Each row names the invariant and the check
that already enforces (or should enforce) it.

| Invariant | Deviance it catches | Check |
|---|---|---|
| Role on a project comes from the grant roster (Constitution III) | Entitlement computed from a free-text label (#283) | `tests/guards/role-vocabulary-parity.test.mjs` |
| Every write names its actor (Constitution X) | Audit rows saying what changed but not who | `tests/guards/provenance-*.test.mjs` |
| One vocabulary across surfaces | Same term spelled differently in KG, exporter, UI | `kg-resource-type-parity`, `source-class-vocabulary` |
| Datasets are registered against a grant | Unregistered datasets (not yet checked) | TODO: metric, see below |

## Scope screen (before adding a row)

A feature belongs here only if the problem is faced by the group (not one lab), the behaviour is
coherent, and the outcome is not harmful. Otherwise model it descriptively, not functionally.

## Next iteration (not in this PR)

- One deviance metric on the site: share of grants with at least one registered dataset.
- A guard asserting every `docs/governance` invariant row names an existing check.
