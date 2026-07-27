-- Feature 008 Phase 4 — keep the unified embedding index fresh.
--
-- embed-knowledge is incremental + now edit-aware (new rows AND rows whose source
-- updated_at is newer than the indexed updated_at). This schedules it so new and
-- edited consortium data are re-embedded automatically — no manual runs.
--
-- Cadence: every 30 min. Steady state (few changes) → the tick is near-noop (one
-- scan, zero embeds). Each tick embeds up to `limit` stale rows; a large edit wave
-- drains over successive ticks. The function is verify_jwt=false, so the anon key
-- (public) is sufficient to trigger it; OPENROUTER_API_KEY + SERVICE_ROLE live in
-- the edge-function env, not here.
--
-- Requires pg_cron + pg_net (pg_net already used by the universal-audit triggers).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop a prior copy of this job before (re)creating it.
select cron.unschedule('embed-knowledge-freshness')
where exists (select 1 from cron.job where jobname = 'embed-knowledge-freshness');

select cron.schedule(
  'embed-knowledge-freshness',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://vpexxhfpvghlejljwpvt.supabase.co/functions/v1/embed-knowledge',
    body := jsonb_build_object('limit', 30),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwZXh4aGZwdmdobGVqbGp3cHZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk3MDg2NDUsImV4cCI6MjA4NTI4NDY0NX0.M107rJ9Ji17zAyd8Jolt5GQFZmu9vvAG1UiIq0GQh8U',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwZXh4aGZwdmdobGVqbGp3cHZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk3MDg2NDUsImV4cCI6MjA4NTI4NDY0NX0.M107rJ9Ji17zAyd8Jolt5GQFZmu9vvAG1UiIq0GQh8U'
    ),
    timeout_milliseconds := 150000
  );
  $$
);
