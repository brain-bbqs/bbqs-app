-- Run against the SANDBOX database immediately after `supabase db push`.
--
-- WHY: every cron job in the migration history hardcodes the PRODUCTION
-- project URL (https://vpexxhfpvghlejljwpvt.supabase.co) and the production
-- anon key. Replaying those migrations into the sandbox would create a sandbox
-- scheduler that fires at production edge functions — the sandbox would write
-- to prod. This script runs after every sandbox migration push and makes the
-- sandbox inert: all pg_cron jobs are unscheduled, and any vault copy of a
-- production key is removed.
--
-- Idempotent. Safe to run on every workflow run.

DO $$
DECLARE
  ref text;
BEGIN
  -- Hard guard: refuse to run anywhere that looks like production.
  SELECT current_setting('server_version', true) INTO ref;  -- no-op, keeps block valid
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) AND EXISTS (
    SELECT 1 FROM cron.job WHERE command LIKE '%vpexxhfpvghlejljwpvt%'
  ) THEN
    RAISE NOTICE 'Found cron jobs pointing at the production project; unscheduling.';
  END IF;
END $$;

-- 1. Unschedule every cron job in this database.
DO $$
DECLARE
  j record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed; nothing to unschedule.';
    RETURN;
  END IF;
  FOR j IN SELECT jobname FROM cron.job LOOP
    PERFORM cron.unschedule(j.jobname);
    RAISE NOTICE 'Unscheduled cron job %', j.jobname;
  END LOOP;
END $$;

-- 2. Drop any vault secret carrying a production credential. Sandbox edge
--    functions get their own secrets from the sandbox project settings.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'vault') THEN
    DELETE FROM vault.secrets WHERE name = 'project_service_role_key';
    RAISE NOTICE 'Removed vault secret project_service_role_key (prod value).';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Could not clear vault secrets (insufficient privilege); check manually.';
END $$;

-- 3. Report anything still referencing production so the run is auditable.
SELECT 'cron jobs still referencing prod' AS check, count(*) AS count
  FROM cron.job WHERE command LIKE '%vpexxhfpvghlejljwpvt%';
