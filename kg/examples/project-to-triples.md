# Worked example: one project → its triples

How a single BBQS project becomes RDF, and how that answers the three questions the `resources`
spine exists to answer. Grant **R34DA059723** — food-handling behavior "in freely moving animals" —
taken from `kg/export/bbqs.ttl`.

## Step 0 — where it starts (the DB)

One row in `grants` (the award facet) joined to one row in `projects` (the science facet) on
`grant_number`, both hanging off one `resources` row. That `resources` row's `id` is the UUID
`2db5ee93-…`. Nothing here is a graph yet — just columns.

## Step 1 — give it an identity (the IRI)

The prefix `bid:` is shorthand for `https://brain-bbqs.org/id/`, so the node's full name is:

    https://brain-bbqs.org/id/2db5ee93-296a-446a-a3e6-59fd3d28c4a6

That UUID is `resources.id`. This is the spine doing its one job: **one row → one permanent address.**

## Step 2 — say what it is (the type), then state its facts

In Turtle, `a` means `rdf:type`, `;` means "same subject, next fact", and a quoted value is a
literal. This is the actual exported text (abstract trimmed):

```turtle
bid:2db5ee93-296a-446a-a3e6-59fd3d28c4a6  a  bbqs:Project ;          # ← TYPE
    bbqs:grant_number         "R34DA059723" ;
    bbqs:mechanism            "R34" ;                                # derived from the grant number
    bbqs:name                 "R34DA059723" ;
    bbqs:award_amount         360000 ;
    bbqs:fiscal_year          2025 ;
    bbqs:external_url         "https://reporter.nih.gov/project-details/5R34DA059723-02" ;
    bbqs:reporter_project_num "5R34DA059723-02" ;
    bbqs:studies_human        false ;
    bbqs:studies_species_name "Freely moving animals" ;              # ← raw claim, unresolved
    bbqs:keywords             "Food-handling", "Foraging", "Kinematics", "Oromanual", "Sensorimotor" ;
    bbqs:abstract             "PROJECT SUMMARY  Oromanual food-handling …" .
```

Every line is one triple: (this project) — (predicate) — (value). The first line is two-in-one:
identity (the subject IRI) + type (`bbqs:Project`). The rest are edges to literal values (text,
numbers, booleans).

Notice `studies_species_name "Freely moving animals"` has **no** matching `bbqs:studies_species →`
(a Species node) — one of our 9 dangling #7 cases living in the graph, exactly as designed so SHACL
can flag it.

## Step 3 — edges to other nodes (relationships), and reification

"Who is the PI?" isn't a simple arrow, because the fact has its own details: which project, which
role, according to whom. So it becomes its own node in the middle — **reification** ("make a
relationship into a thing"):

```turtle
bid:role/c3e5b648-…  a  bbqs:ProjectRole ;
    bbqs:on_project   bid:2db5ee93-… ;      # ← points back at our project
    bbqs:held_by      bid:9dc36d12-… ;      # ← points at the investigator (see the bug note)
    bbqs:project_role "contact_pi" ;
    bbqs:role_source  "reporter" .
```

`on_project` and `held_by` are edges between nodes (not literals). Read it back as English: "There
is a role — on project R34DA059723, held by an investigator, the role is `contact_pi`, and we know
this from RePORTER." That middle node lets one person hold different roles on different projects
without contradiction. (In the current *anon* export `held_by` is omitted — see the Bonus.)

## The three spine questions, answered by this example

| Question | Answered by |
|---|---|
| **Identity** — what IRI? | `bid:2db5ee93-…` (from `resources.id`) |
| **Type** — what is it? | `a bbqs:Project` (from `resource_type`) |
| **Attachment** — where do cross-cutting edges land? | the ProjectRole points its `on_project` at `bid:2db5ee93-…`; provenance / comments / embeddings target that same IRI |

One row → one typed, addressable node → everything else points at it.

## Bonus: this example caught a real bug 🐛 (now fixed)

In the first export, `held_by bid:9dc36d12-…` landed on **nothing** — there was no
`bid:9dc36d12-… a bbqs:Investigator` node. Why? The exporter minted Investigator nodes from
`resources.id` but minted the `held_by` target from `grant_investigators.investigator_id` — **two
different keys for the same person** (`investigators.id ≠ investigators.resource_id`). So every
`held_by` dangled.

This is the exact failure the identity-spine argument is about: use two keys for one entity and it
becomes "two things", so the arrow can't find the node.

**The fix (commit `bb0394c`):** resolve `investigator_id → resources.id` before minting `held_by`.
Under the anon export the `investigators` table is RLS-hidden, so `held_by` can't be resolved and is
**omitted rather than dangled** — it's emitted in the full-access export (Phase 6). A referential
SHACL shape (`HeldByResolvesShape`: `held_by` must point at a `bbqs:Investigator`) now guards it,
proven RED first — it fired on all 111 roles in the pre-fix graph, green after.
