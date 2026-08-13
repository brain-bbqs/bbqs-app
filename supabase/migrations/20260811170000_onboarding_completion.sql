-- Onboarding can actually COMPLETE: stamp onboarding_completed_at, and list the graduates.
--
-- THE BUG. The pipeline leaves a member out once onboarding_completed_at IS NOT NULL. Every writer sets
-- that column to NULL -- onboard_member (three generations of it), offboard_member -- and NOTHING has
-- ever set it to a timestamp. So the exit condition could not become true through normal operation:
-- finishing every step left you sitting in the console at 7/7 indefinitely. Two members are in exactly
-- that state today (Nader Nikbakht 6/6, Gabriella 6/7 with only an optional step open).
--
-- That inverts the console's purpose. A queue you cannot leave stops being a work list and becomes
-- wallpaper: the rows that need attention are indistinguishable from the rows that are finished.
--
-- THE FIX. A trigger derives completion from the checklist, the same way is_stuck does, rather than
-- asking a caller to remember. Live state, not a cached flag (Principle III):
--   * no required step outstanding  -> stamp completed_at (keeping any earlier stamp)
--   * a required step reopens       -> CLEAR it, and they return to the pipeline
-- The second half matters as much as the first. If a member later joins a grant that adds a
-- data_questionnaire, or an admin re-runs a stage, they are genuinely not finished any more and the
-- console must say so. A completion flag that outlives its own truth is the bug this file exists to
-- remove, so it must not be reintroduced in the other direction.
--
-- Optional steps (wg_groups, working_groups) never block completion, matching is_stuck.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260811170000');

/** How many REQUIRED steps are still open. One definition, read by the trigger and both views --
 *  three copies of this predicate is how is_stuck and completion would drift apart. */
CREATE OR REPLACE FUNCTION public.onboarding_required_open(_checklist jsonb)
RETURNS int LANGUAGE sql IMMUTABLE AS $fn$
  SELECT count(*)::int
    FROM jsonb_each_text(coalesce(_checklist, '{}'::jsonb)) kv
   WHERE kv.key NOT IN ('pre_check', 'wg_groups', 'working_groups')
     AND kv.value IN ('pending', 'queued', 'not_started')
$fn$;

COMMENT ON FUNCTION public.onboarding_required_open(jsonb) IS
  'Count of required (non-meta, non-optional) onboarding steps still open. Metadata keys are excluded structurally because only a status value can match.';

CREATE OR REPLACE FUNCTION public.stamp_onboarding_completed()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- Offboarded records are out of scope: their checklist is {status: offboarded} and stamping them
  -- complete would file a departure as a graduation.
  IF coalesce(NEW.onboarding_checklist ->> 'status', '') = 'offboarded' THEN
    RETURN NEW;
  END IF;

  IF NEW.onboarding_checklist ->> 'pre_check' = 'done'
     AND public.onboarding_required_open(NEW.onboarding_checklist) = 0 THEN
    -- coalesce: keep the ORIGINAL completion date. Re-running a stage that is already done must not
    -- restate when they finished.
    NEW.onboarding_completed_at := coalesce(NEW.onboarding_completed_at, now());
  ELSE
    NEW.onboarding_completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.stamp_onboarding_completed() IS
  'Derives onboarding_completed_at from the checklist on every write: stamped when no required step is open, cleared when one reopens. Replaces the convention that callers set it, which no caller ever did.';

DROP TRIGGER IF EXISTS trg_stamp_onboarding_completed ON public.investigators;
CREATE TRIGGER trg_stamp_onboarding_completed
  BEFORE INSERT OR UPDATE OF onboarding_checklist ON public.investigators
  FOR EACH ROW EXECUTE FUNCTION public.stamp_onboarding_completed();

-- Backfill: anyone already finished graduates now. Touching onboarding_checklist is what fires the
-- trigger, so assign it to itself; the group-sync trigger watches role/working_groups and cannot fire.
UPDATE public.investigators
   SET onboarding_checklist = onboarding_checklist
 WHERE onboarding_checklist ->> 'pre_check' = 'done'
   AND coalesce(onboarding_checklist ->> 'status', '') <> 'offboarded'
   AND public.onboarding_required_open(onboarding_checklist) = 0
   AND onboarding_completed_at IS NULL;

-- ── The graduates ───────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.onboarding_completed
WITH (security_invoker = true)
AS
SELECT i.id,
       i.name,
       i.email,
       i.role,
       i.working_groups,
       i.created_at,
       i.onboarding_checklist AS checklist,
       i.onboarding_completed_at AS completed_at,
       nullif(i.onboarding_checklist ->> 'started_at', '')::timestamptz AS started_at,
       -- How long onboarding took. NULL when the start is unknown (records predating the audit trail),
       -- which is honest: a zero would read as "instant".
       CASE
         WHEN nullif(i.onboarding_checklist ->> 'started_at', '') IS NOT NULL
           THEN floor(extract(epoch FROM (i.onboarding_completed_at
                  - (i.onboarding_checklist ->> 'started_at')::timestamptz)) / 86400)::int
       END AS days_to_complete,
       (SELECT count(*) FROM jsonb_each_text(coalesce(i.onboarding_checklist, '{}'::jsonb)) kv
         WHERE kv.key <> 'pre_check' AND kv.value IN ('done','skipped')) AS steps_done,
       (SELECT count(*) FROM jsonb_each_text(coalesce(i.onboarding_checklist, '{}'::jsonb)) kv
         WHERE kv.key <> 'pre_check'
           AND kv.value IN ('done','skipped','pending','queued','not_started')) AS steps_total,
       coalesce((SELECT count(*) FROM public.grant_investigators gi
                  WHERE gi.investigator_id = i.id), 0) AS live_grant_count,
       -- Steps deliberately skipped rather than done: worth seeing on a completion list, since
       -- "complete" then means "nobody is chasing this", not "everything happened".
       (SELECT array_agg(kv.key ORDER BY kv.key)
          FROM jsonb_each_text(coalesce(i.onboarding_checklist, '{}'::jsonb)) kv
         WHERE kv.value = 'skipped') AS skipped_steps
  FROM public.investigators i
 WHERE i.onboarding_completed_at IS NOT NULL
   AND coalesce(i.onboarding_checklist ->> 'status', '') <> 'offboarded';

COMMENT ON VIEW public.onboarding_completed IS
  'Members who finished onboarding: when, how long it took, and which steps were skipped rather than done. Complement of onboarding_pipeline — a member appears in exactly one of the two, and returns to the pipeline automatically if a required step reopens.';

GRANT SELECT ON public.onboarding_completed TO authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_required_open(jsonb) TO authenticated, service_role;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) The two who were stuck at "finished but still listed" should now appear here.
SELECT name, email, completed_at::date, days_to_complete, steps_done, steps_total, skipped_steps
  FROM public.onboarding_completed
 ORDER BY completed_at DESC;

-- 2) Nobody may be in both lists, and nobody finished may still be in the pipeline.
SELECT (SELECT count(*) FROM public.onboarding_pipeline)  AS in_pipeline,
       (SELECT count(*) FROM public.onboarding_completed) AS completed,
       (SELECT count(*) FROM public.onboarding_pipeline p
          JOIN public.onboarding_completed c ON c.id = p.id) AS in_both_must_be_zero,
       (SELECT count(*) FROM public.onboarding_pipeline p
         WHERE public.onboarding_required_open(p.checklist) = 0) AS finished_but_still_listed_must_be_zero;
