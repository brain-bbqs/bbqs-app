-- Track onboarding reminders so we don't spam members.
--   • investigators.last_reminder_sent_at / reminder_count — when we last nudged them, how often.
--   • record_onboarding_reminder() — stamped by the console right after a reminder is sent.
--   • onboarding_pipeline exposes both, so the panel can show "reminded 3d ago" and warn
--     before sending again.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor.

ALTER TABLE public.investigators
  ADD COLUMN IF NOT EXISTS last_reminder_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.record_onboarding_reminder(_investigator_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid(); _at timestamptz; _n integer;
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can record a reminder';
  END IF;
  UPDATE public.investigators
     SET last_reminder_sent_at = now(),
         reminder_count = coalesce(reminder_count, 0) + 1
   WHERE id = _investigator_id
   RETURNING last_reminder_sent_at, reminder_count INTO _at, _n;
  IF NOT FOUND THEN RAISE EXCEPTION 'Investigator % not found', _investigator_id; END IF;
  RETURN jsonb_build_object('ok', true, 'last_reminder_sent_at', _at, 'reminder_count', _n);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_onboarding_reminder(uuid) TO authenticated;

-- Pipeline view + the two reminder columns (appended, so CREATE OR REPLACE is safe).
CREATE OR REPLACE VIEW public.onboarding_pipeline
WITH (security_invoker = true)
AS
WITH base AS (
  SELECT i.id, i.name, i.email, i.role, i.working_groups, i.created_at,
         i.onboarding_checklist AS checklist,
         i.last_reminder_sent_at, coalesce(i.reminder_count, 0) AS reminder_count,
         coalesce((SELECT count(*) FROM public.grant_investigators gi WHERE gi.investigator_id = i.id), 0) AS live_grant_count
  FROM public.investigators i
  WHERE i.onboarding_completed_at IS NULL
    AND i.onboarding_checklist ->> 'pre_check' = 'done'
    AND coalesce(i.onboarding_checklist ->> 'status', '') <> 'offboarded'
),
steps AS (
  SELECT b.id,
    count(*) FILTER (WHERE kv.key NOT IN ('status','offboarded_at','pre_check')) AS steps_total,
    count(*) FILTER (WHERE kv.key NOT IN ('status','offboarded_at','pre_check') AND kv.value IN ('done','skipped')) AS steps_done,
    count(*) FILTER (WHERE kv.key NOT IN ('status','offboarded_at','pre_check','wg_groups','working_groups') AND kv.value NOT IN ('done','skipped')) AS required_incomplete,
    count(*) FILTER (WHERE kv.key NOT IN ('status','offboarded_at','pre_check') AND kv.value IN ('pending','queued')) AS steps_in_flight
  FROM base b
  LEFT JOIN LATERAL jsonb_each_text(b.checklist) AS kv ON true
  GROUP BY b.id
)
SELECT b.id, b.name, b.email, b.role, b.working_groups, b.created_at, b.checklist, b.live_grant_count,
  floor(extract(epoch FROM (now() - b.created_at)) / 86400)::int AS days_since_created,
  coalesce(s.steps_done, 0) AS steps_done,
  coalesce(s.steps_total, 0) AS steps_total,
  (floor(extract(epoch FROM (now() - b.created_at)) / 86400) > 14 AND coalesce(s.required_incomplete, 0) > 0) AS is_stuck,
  b.last_reminder_sent_at,
  b.reminder_count
FROM base b JOIN steps s ON s.id = b.id
WHERE b.live_grant_count > 0 OR coalesce(s.steps_in_flight, 0) > 0;
