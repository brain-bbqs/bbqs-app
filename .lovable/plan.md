# Table cleanup plan

70 tables in the database today. Below is what I found for each group you named, and what I
recommend. Nothing gets dropped until you approve the list.

## Safe to drop now — empty and nothing reads them

| Table | Rows | Notes |
|---|---|---|
| device_category_ml_specs | 0 | Never populated |
| device_category_parameters | 0 | Never populated |
| device_category_pitfalls | 0 | Never populated |
| device_category_references | 0 | Never populated |
| reporter_pi_observations | 0 | Leftover from the PI sync experiment |
| harvester_synonyms | 0 | Part of the harvester group below |

Note: `device_categories` itself has 34 rows and feeds the device pages — it stays.

## Lovable billing — drop the whole group

`lovable_credit_events` (0 rows), `lovable_user_usage` (0 rows), `lovable_invoices` (22 rows).
This goes away with Lovable anyway. Work involved:

- Export the 22 invoices to a CSV first so the spend history isn't lost.
- Delete the two admin panels (`LovableCreditsPanel`, `LovableInvoicesPanel`) and their tab in the
  admin console.
- Retire the `budget-sync` background job's Lovable portion.
- Drop the three tables.

## Harvester — drop, but it is not empty

`harvester_runs` (5,582), `harvester_keywords` (820), `harvester_queue` (30),
`harvester_relations` (11), `harvester_settings` (1), `harvester_synonyms` (0).

Two background jobs still write to these (`harvester-tick`, `harvest-grant-methods-multihop`), and
`grant_methods_traversal_paths` (5,100 rows) and `grant_methods_evidence` (33 rows) are the output
they produced — those feed the Grant Methods Evidence page.

Recommended: delete the two background jobs and the six harvester tables, keep the evidence and
traversal tables so the page keeps working. If you'd rather keep the pipeline runnable, we stop the
scheduled jobs instead and leave the tables.

## Slack — my recommendation is keep

`slack_channel_members` (499), `slack_channel_pending` (243), `slack_channels` (6). These are live:
the Slack survey tool and the group audit dialog in the admin console both read them, and the
member roster is real data. Dropping them removes those two features. Say the word and I will, but
it isn't dead weight.

## Feature suggestions — my recommendation is keep

`feature_suggestions` (22 real entries), `feature_votes` (2). This is the Suggest a Feature page you
asked for recently and it has content in it. Removing it means deleting the page too.

## Other empty tables worth a decision

| Table | Rows | What it does |
|---|---|---|
| working_group_dashboard_defaults | 0 | Powers the working-group dashboard defaults admin panel — feature built, never filled in |
| group_audit_dismissals | 0 | Stores "ignore this" choices in the group audit — empty because nobody has dismissed anything yet |
| cohort_summaries | 2 | Cohort heatmap |
| system_alerts | 1 | Admin alert banner |

These are empty because the feature is new, not because it's dead. I'd leave all four.

## How the drops happen

One migration per group so each can be reviewed and rolled back independently:

1. `drop_empty_device_category_tables`
2. `drop_lovable_billing_tables` (after the CSV export)
3. `drop_harvester_tables`

Each drop also removes the matching rows in `field_provenance` and the provenance exclusion
entries, and removes the tables from the data-model diagram (`src/data/data-model-schema.ts`) so
the schema page stays accurate. Frontend and edge-function code is deleted in the same pass, before
the migration runs, so nothing queries a missing table.

## What I need from you

- Confirm the harvester group goes (drop tables + jobs) rather than just pausing the jobs.
- Confirm Slack and Suggest a Feature stay, or tell me to remove them.
- Confirm you want the invoice CSV before the billing tables go.
