# Worked example: one project → its triples

How a single BBQS project becomes RDF, and how that answers the three questions the `resources`
spine exists to answer. Taken from `kg/export/bbqs.ttl` (the anon export) for grant
**R34DA059723** — recording food-handling behavior "in freely moving animals."

## The triples

```turtle
@prefix bbqs: <https://brain-bbqs.org/schema#> .
@prefix bid:  <https://brain-bbqs.org/id/> .

# The Project node — grants ⋈ projects, joined on grant_number
bid:2db5ee93-296a-446a-a3e6-59fd3d28c4a6 a bbqs:Project ;
    bbqs:name                 "R34DA059723" ;
    bbqs:grant_number         "R34DA059723" ;
    bbqs:mechanism            "R34" ;                     # derived from the grant number
    bbqs:award_amount         360000 ;
    bbqs:studies_human        false ;
    bbqs:studies_species_name "Freely moving animals" ;   # ← unresolved; see #7 below
    bbqs:abstract             "PROJECT SUMMARY  Oromanual food-handling …" .

# The per-project role, reified from one grant_investigators row
bid:role/c3e5b648-cf18-47f4-b514-fc38390d2431 a bbqs:ProjectRole ;
    bbqs:on_project   bid:2db5ee93-296a-446a-a3e6-59fd3d28c4a6 ;
    bbqs:project_role "contact_pi" ;
    bbqs:role_source  "reporter" .
    # bbqs:held_by is OMITTED here: under the anon export the investigators table is RLS-hidden,
    # so investigator_id can't be resolved to its resources.id node. held_by is emitted only in the
    # full-access export (Phase 6). We never write a dangling held_by — see HeldByResolvesShape.
```

## Why this shape — the three spine questions

The `resources` spine exists to answer three questions for every node, uniformly. This one project
answers all three:

1. **Identity — what IRI?** `bid:2db5ee93-…` *is* `resources.id`: one project, one stable UUID IRI.
   The role is its own node (`bid:role/c3e5b648-…`), reified because a role is a fact *about* a
   (project, investigator) pair — not a property of either one.
2. **Type — what is it?** `a bbqs:Project`, from `resources.resource_type = 'grant'` ("grant" is
   only NIH's word; the node is the BBQS Project). The role is `a bbqs:ProjectRole`.
3. **Attachment — where do edges hang?** `on_project` points back at the project's `resources.id`,
   and provenance / comments / embeddings all attach to that same IRI. `role_source "reporter"`
   records where the role came from — provenance travels with the edge.

The identity question is why the `held_by` fix mattered: `grant_investigators.investigator_id` is a
*different* key (`investigators.id`) than the node's IRI (`resources.id`). Pointing `held_by` at the
wrong key made it dangle — a second IRI for the same person. Resolve it through
`investigators.id → resources.id`, or omit it; never mint a phantom.

## A live inconsistency in this very node (#7)

`studies_species_name "Freely moving animals"` has **no** matching `studies_species` link — it isn't
a species, so no `species_aliases` row resolves it. That's one of the 9 dangling `study_species`
values the harness flags (invariant #7). The graph faithfully records the raw claim *and* the fact
that it doesn't resolve — which is exactly what lets us detect the contradiction instead of silently
dropping it.
