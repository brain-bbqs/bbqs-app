-- "Stuck" must be measured from when ONBOARDING started, not from when the record was created.
--
-- THE SYMPTOM. The dashboard showed "Bijan Pesaran — pesaran@upenn.edu: stuck, 4 months ago". He was
-- onboarded on 2026-08-10, the day before. His investigators row dates from 2026-04-06 (an earlier
-- import), so days_since_created read 128 and the stuck rule (>14 days AND a required step open)
-- fired immediately. His only open step is data_questionnaire, which is legitimately outstanding and
-- one day old.
--
-- THE CLASS. days_since_created reads investigators.created_at — the age of the RECORD. Onboarding
-- age is a different quantity, and they diverge for exactly the people the console now handles best:
-- every RePORTER stub adopted by onboard_member (24 such records), every merged duplicate, every
-- legacy member re-onboarded. Those all arrive pre-aged and are branded stuck on arrival, which
-- inverts the signal: the rows shouting loudest are the ones just dealt with.
--
-- THE FIX. Stamp when onboarding actually began and measure from that, falling back to created_at
-- when it is unknown. The stamp lives in onboarding_checklist as 'started_at' rather than a new
-- column, because migration 20260810160000 made the pipeline count an entry as a STEP only when its
-- VALUE is a status — a timestamp is self-evidently metadata and is excluded automatically, with no
-- blacklist to maintain. (That is the same property that stopped 'source' and 'finished_by_admin'
-- counting as unfinishable steps.)
--
-- Backfill uses data_audit_log: the first audited write that touched onboarding_checklist is when
-- onboarding demonstrably began. The audit trail only starts 2026-07-24, so anything earlier keeps
-- created_at — honest, since we genuinely do not know.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260811150000');

-- ── Backfill started_at for rows still in flight ────────────────────────────────────────────────
-- Group-sync trigger stays ENABLED: this touches onboarding_checklist only, and that trigger fires
-- on role/working_groups, so no Google Group call can result.
WITH first_touch AS (
  SELECT a.record_id::uuid AS investigator_id,
         min(a.occurred_at) AS started_at
    FROM public.data_audit_log a
   WHERE a.table_name = 'investigators'
     AND a.record_id IS NOT NULL
     AND (a.changed_fields ? 'onboarding_checklist'
          OR a.new_data ? 'onboarding_checklist')
   GROUP BY a.record_id
)
UPDATE public.investigators i
   SET onboarding_checklist =
         coalesce(i.onboarding_checklist, '{}'::jsonb)
         || jsonb_build_object('started_at', to_char(ft.started_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'))
  FROM first_touch ft
 WHERE ft.investigator_id = i.id
   AND i.onboarding_checklist IS NOT NULL
   AND NOT (i.onboarding_checklist ? 'started_at');

-- ── Stamped going forward by a TRIGGER, not by onboard_member ──────────────────────────────────
-- A trigger rather than a line inside onboard_member, because onboard_member is not the only writer:
-- the agent's onboarding workflow seeds checklists too, and so does the SQL editor. Putting the stamp
-- in one of the callers would leave the others producing rows with no clock, which is the same
-- one-site-of-a-class mistake as the original bug.
--
-- Fires only when the checklist says onboarding has begun (pre_check done) and no stamp exists yet.
-- Never overwrites: re-onboarding must not reset the clock and make a genuinely stale member look
-- fresh, which would turn this fix into the opposite bug.
CREATE OR REPLACE FUNCTION public.stamp_onboarding_started()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.onboarding_checklist IS NOT NULL
     AND NEW.onboarding_checklist ->> 'pre_check' = 'done'
     AND NOT (NEW.onboarding_checklist ? 'started_at') THEN
    NEW.onboarding_checklist :=
      NEW.onboarding_checklist
      || jsonb_build_object('started_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'));
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.stamp_onboarding_started() IS
  'BEFORE INSERT/UPDATE on investigators: records when onboarding began, once, for every writer (console RPC, agent workflow, SQL editor). Never overwrites an existing stamp.';

DROP TRIGGER IF EXISTS trg_stamp_onboarding_started ON public.investigators;
CREATE TRIGGER trg_stamp_onboarding_started
  BEFORE INSERT OR UPDATE OF onboarding_checklist ON public.investigators
  FOR EACH ROW EXECUTE FUNCTION public.stamp_onboarding_started();

-- ── The view measures from started_at ──────────────────────────────────────────────────────────
-- Rebuilt on 20260810160000's definition (value-is-a-status step counting) plus 20260807180000's
-- trailing reminder columns. CREATE OR REPLACE VIEW cannot drop or reorder columns, so
-- days_since_created keeps its name and position — renaming it would 42P16 and break the panel.
-- Its MEANING changes to "days since onboarding started", which is what every caller wanted.
CREATE OR REPLACE VIEW public.onboarding_pipeline
WITH (security_invoker = true)
AS
WITH base AS (
  SELECT i.id, i.name, i.email, i.role, i.working_groups, i.created_at,
         i.onboarding_checklist AS checklist,
         i.last_reminder_sent_at, coalesce(i.reminder_count, 0) AS reminder_count,
         -- The clock: when onboarding began, else the record's own age when we cannot know.
         coalesce(
           nullif(i.onboarding_checklist ->> 'started_at', '')::timestamptz,
           i.created_at
         ) AS clock_from,
         coalesce((SELECT count(*) FROM public.grant_investigators gi WHERE gi.investigator_id = i.id), 0) AS live_grant_count
  FROM public.investigators i
  WHERE i.onboarding_completed_at IS NULL
    AND i.onboarding_checklist ->> 'pre_check' = 'done'
    AND coalesce(i.onboarding_checklist ->> 'status', '') <> 'offboarded'
),
steps AS (
  SELECT b.id,
    count(*) FILTER (
      WHERE kv.key <> 'pre_check'
        AND kv.value IN ('done','skipped','pending','queued','not_started')
    ) AS steps_total,
    count(*) FILTER (
      WHERE kv.key <> 'pre_check'
        AND kv.value IN ('done','skipped')
    ) AS steps_done,
    count(*) FILTER (
      WHERE kv.key NOT IN ('pre_check','wg_groups','working_groups')
        AND kv.value IN ('pending','queued','not_started')
    ) AS required_incomplete,
    count(*) FILTER (
      WHERE kv.key <> 'pre_check'
        AND kv.value IN ('pending','queued')
    ) AS steps_in_flight
  FROM base b
  LEFT JOIN LATERAL jsonb_each_text(b.checklist) AS kv ON true
  GROUP BY b.id
)
SELECT b.id, b.name, b.email, b.role, b.working_groups, b.created_at, b.checklist, b.live_grant_count,
  floor(extract(epoch FROM (now() - b.clock_from)) / 86400)::int AS days_since_created,
  coalesce(s.steps_done, 0) AS steps_done,
  coalesce(s.steps_total, 0) AS steps_total,
  (floor(extract(epoch FROM (now() - b.clock_from)) / 86400) > 14
     AND coalesce(s.required_incomplete, 0) > 0) AS is_stuck,
  b.last_reminder_sent_at,
  b.reminder_count
FROM base b JOIN steps s ON s.id = b.id
WHERE b.live_grant_count > 0 OR coalesce(s.steps_in_flight, 0) > 0;

COMMENT ON VIEW public.onboarding_pipeline IS
  'Members with onboarding in progress. days_since_created and is_stuck measure from onboarding_checklist->>started_at (when onboarding began), falling back to investigators.created_at — measuring from the record age branded every adopted RePORTER stub and re-onboarded legacy member as stuck on arrival. A checklist entry counts as a step only when its VALUE is a status, so metadata keys (started_at, source, finished_by_admin) are excluded structurally. security_invoker: investigators RLS gates visibility.';

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Bijan: onboarded 2026-08-10, record from 2026-04-06. Expect days_since_created ~1 and
--    is_stuck FALSE, with data_questionnaire still the one open step.
SELECT name, email, days_since_created, steps_done, steps_total, is_stuck,
       checklist ->> 'started_at' AS started_at, created_at::date AS record_created
  FROM public.onboarding_pipeline
 WHERE email = 'pesaran@upenn.edu';

-- 2) How many rows stop being "stuck" purely because the clock is now right.
SELECT count(*) FILTER (WHERE is_stuck) AS still_stuck,
       count(*) AS in_pipeline,
       count(*) FILTER (WHERE checklist ? 'started_at') AS have_started_at
  FROM public.onboarding_pipeline;
