# News Radar — Automated Announcements Pipeline

The Announcements page is fed by two paths: **manual posts** by signed-in members, and
**News Radar**, a nightly poller that proposes science-news items for admin approval.

## Flow

```mermaid
flowchart TD
    subgraph Sources["7 curated RSS/Atom feeds"]
        F1[NIH Director's Blog]
        F2[NIMH News]
        F3[Nature Neuroscience]
        F4[Neuron / Cell Press]
        F5[NYT Science]
        F6[Quanta Magazine]
        F7[STAT News Neuroscience]
    end

    CRON[["pg_cron 03:42 UTC nightly"]] --> FN
    Sources --> FN["edge fn: news-radar-poll"]
    FN --> PARSE["Parse RSS/Atom, strip HTML"]
    PARSE --> SCORE["Score vs BBQS keyword profile<br/>(brain, neuro, EEG, HRV, ML, ...)"]
    SCORE --> DEDUP{"URL already seen?"}
    DEDUP -- yes --> SKIP[Skip]
    DEDUP -- no --> NC[("news_candidates<br/>status = pending")]

    NC --> PANEL["Admin Console -> News Radar panel"]
    PANEL --> DEC{Curator decision}
    DEC -- Reject --> REJ[("status = rejected<br/>+ review notes")]
    DEC -- "Approve & post" --> ANN[("announcements row<br/>external link")]
    ANN --> POSTED[("status = posted<br/>announcement_id linked")]
    POSTED --> PAGE["/announcements page"]

    MANUAL["Member posts manually"] --> ANN
```

## Components

| Piece | Location | Role |
| --- | --- | --- |
| Poller | `supabase/functions/news-radar-poll/` | Fetch, parse, keyword-score, insert candidates |
| Schedule | `pg_cron` job, 03:42 UTC daily | Runs the poller unattended |
| Queue table | `public.news_candidates` | Pending / approved / rejected / posted |
| Review UI | `src/components/admin/NewsRadarPanel.tsx` | Filter by status, notes, one-click approve |
| Public page | `src/pages/Announcements.tsx` | Renders `announcements`, newest first |

## Scoring & de-duplication

- Case-insensitive substring match of item title + summary against the BBQS keyword list.
- `score` = number of distinct keyword hits; matched terms stored in `matched_keywords[]`.
- Items with zero hits are discarded, never stored.
- `url` is unique — re-polling the same feed is idempotent.

## Approval semantics

Approving inserts a row into `announcements` (`is_external_link = true`, link text
`Read on <source>`), then flips the candidate to `posted` and stores `announcement_id`,
`reviewed_by`, `reviewed_at`, and any `review_notes`. Rejections keep the row for
audit but never surface publicly.

## Tuning

Feeds and keywords are plain arrays at the top of `news-radar-poll/index.ts`.
Add a feed or a term and redeploy — no schema change required.
"Poll now" in the admin panel triggers an out-of-band run.
