-- Onboarding pipeline view — the single source of truth for onboarding STATUS, shared by
-- the chat agent (listOnboardingPipeline) and the new KG-site admin console status panel.
-- Faithfully mirrors bbqs-agent's checklist.ts derivation so both surfaces agree.
--
-- security_invoker = true → the querying user's RLS on `investigators` applies (the
-- "Owners curators and admins can view investigators" policy), so admins/curators see the
-- whole pipeline and a plain member sees only their own row. No separate policy needed.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor
-- (project vpexxhfpvghlejljwpvt).

CREATE OR REPLACE VIEW public.onboarding_pipeline
WITH (security_invoker = true)
AS
WITH base AS (
  SELECT
    i.id,
    i.name,
    i.email,
    i.role,
    i.working_groups,
    i.created_at,
    i.onboarding_checklist AS checklist,
    coalesce(
      (SELECT count(*) FROM public.grant_investigators gi WHERE gi.investigator_id = i.id),
      0
    ) AS live_grant_count
  FROM public.investigators i
  WHERE i.onboarding_completed_at IS NULL                            -- not complete
    AND i.onboarding_checklist ->> 'pre_check' = 'done'              -- a real run started
    AND coalesce(i.onboarding_checklist ->> 'status', '') <> 'offboarded'  -- not offboarded
),
steps AS (
  SELECT
    b.id,
    -- non-meta steps = the real checklist steps (denominator)
    count(*) FILTER (
      WHERE kv.key NOT IN ('status', 'offboarded_at', 'pre_check')
    ) AS steps_total,
    count(*) FILTER (
      WHERE kv.key NOT IN ('status', 'offboarded_at', 'pre_check') AND kv.value = 'done'
    ) AS steps_done,
    -- REQUIRED = non-meta AND non-optional (wg_groups/working_groups never block)
    count(*) FILTER (
      WHERE kv.key NOT IN ('status', 'offboarded_at', 'pre_check', 'wg_groups', 'working_groups')
        AND kv.value <> 'done'
    ) AS required_incomplete,
    count(*) FILTER (
      WHERE kv.key NOT IN ('status', 'offboarded_at', 'pre_check')
        AND kv.value IN ('pending', 'queued')
    ) AS steps_in_flight
  FROM base b
  LEFT JOIN LATERAL jsonb_each_text(b.checklist) AS kv ON true
  GROUP BY b.id
)
SELECT
  b.id,
  b.name,
  b.email,
  b.role,
  b.working_groups,
  b.created_at,
  b.checklist,
  b.live_grant_count,
  floor(extract(epoch FROM (now() - b.created_at)) / 86400)::int AS days_since_created,
  coalesce(s.steps_done, 0)  AS steps_done,
  coalesce(s.steps_total, 0) AS steps_total,
  (
    floor(extract(epoch FROM (now() - b.created_at)) / 86400) > 14
    AND coalesce(s.required_incomplete, 0) > 0
  ) AS is_stuck
FROM base b
JOIN steps s ON s.id = b.id
-- pipeline gate: drop zero-grant "ghost" records unless a step is genuinely in flight
WHERE b.live_grant_count > 0 OR coalesce(s.steps_in_flight, 0) > 0;

COMMENT ON VIEW public.onboarding_pipeline IS
  'Members with onboarding in progress + derived status (steps_done/total, days_since_created, is_stuck). Mirrors bbqs-agent checklist.ts. security_invoker: investigators RLS gates visibility.';
