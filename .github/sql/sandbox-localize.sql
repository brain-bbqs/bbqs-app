-- Run against the SANDBOX database immediately after the schema clone.
--
-- WHY: every cron job in production hardcodes the PRODUCTION project URL
-- (https://vpexxhfpvghlejljwpvt.supabase.co) and the production anon key.
-- Cloning that into the sandbox would create a sandbox scheduler that fires at
-- production edge functions. This script makes the sandbox inert: all pg_cron
-- jobs are unscheduled and any vault copy of a production key is removed.
--
-- Every cron reference is DYNAMIC (EXECUTE) and guarded by to_regclass, because
-- pg_cron may not be installed in the sandbox at all — a static reference to
-- cron.job fails to parse there ("relation cron.job does not exist").
--
-- Idempotent. Safe to run on every workflow run.

DO $$
DECLARE
  j record;
  n integer := 0;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron not installed in this database; nothing to unschedule.';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM cron.job WHERE command LIKE ''%vpexxhfpvghlejljwpvt%'''
    INTO n;
  IF n > 0 THEN
    RAISE NOTICE 'Found % cron job(s) pointing at production; unscheduling all jobs.', n;
  END IF;

  FOR j IN EXECUTE 'SELECT jobname FROM cron.job' LOOP
    EXECUTE format('SELECT cron.unschedule(%L)', j.jobname);
    RAISE NOTICE 'Unscheduled cron job %', j.jobname;
  END LOOP;
END $$;

-- Drop any vault secret carrying a production credential. Sandbox edge
-- functions get their own secrets from the sandbox project settings.
DO $$
BEGIN
  IF to_regclass('vault.secrets') IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE name = 'project_service_role_key';
    RAISE NOTICE 'Removed vault secret project_service_role_key (prod value).';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Could not clear vault secrets (insufficient privilege); check manually.';
END $$;

-- Report anything still referencing production so the run is auditable.
DO $$
DECLARE
  n integer := 0;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM cron.job WHERE command LIKE ''%vpexxhfpvghlejljwpvt%'''
      INTO n;
  END IF;
  RAISE NOTICE 'cron jobs still referencing prod: %', n;
END $$;
