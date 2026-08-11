-- 1. Store the project base URL + publishable anon key in the vault so cron
--    commands never hardcode them again.
DO $$
DECLARE
  v_url text := 'https://vpexxhfpvghlejljwpvt.supabase.co';
  v_anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwZXh4aGZwdmdobGVqbGp3cHZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk3MDg2NDUsImV4cCI6MjA4NTI4NDY0NX0.M107rJ9Ji17zAyd8Jolt5GQFZmu9vvAG1UiIq0GQh8U';
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'project_url';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(v_url, 'project_url', 'Base URL of this Supabase project (used by pg_cron via public.cron_invoke).');
  ELSE
    PERFORM vault.update_secret(v_id, v_url);
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = 'project_anon_key';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(v_anon, 'project_anon_key', 'Publishable anon key. Fallback credential for cron_invoke when the service role key is absent.');
  ELSE
    PERFORM vault.update_secret(v_id, v_anon);
  END IF;
END $$;

-- 2. Single entry point for every scheduled edge-function call.
CREATE OR REPLACE FUNCTION public.cron_invoke(
  _function text,
  _body jsonb DEFAULT '{}'::jsonb,
  _query text DEFAULT NULL,
  _timeout_ms integer DEFAULT 30000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, net, extensions
AS $$
DECLARE
  v_base text;
  v_key text;
  v_url text;
  v_req bigint;
BEGIN
  IF _function IS NULL OR _function !~ '^[a-z0-9][a-z0-9\-_]*$' THEN
    RAISE EXCEPTION 'cron_invoke: invalid function name %', _function;
  END IF;

  SELECT decrypted_secret INTO v_base
    FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'cron_invoke: vault secret "project_url" is not set.';
  END IF;

  -- Prefer the service role key; fall back to the anon key when it is absent
  -- or still the placeholder, so jobs degrade instead of failing silently.
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets WHERE name = 'project_service_role_key' LIMIT 1;
  IF v_key IS NULL OR v_key !~ '^eyJ' OR length(v_key) < 100 THEN
    SELECT decrypted_secret INTO v_key
      FROM vault.decrypted_secrets WHERE name = 'project_anon_key' LIMIT 1;
  END IF;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'cron_invoke: no usable credential in vault (project_service_role_key / project_anon_key).';
  END IF;

  v_url := rtrim(v_base, '/') || '/functions/v1/' || _function
           || CASE WHEN _query IS NULL OR _query = '' THEN '' ELSE '?' || _query END;

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_key,
      'Authorization', 'Bearer ' || v_key
    ),
    body := COALESCE(_body, '{}'::jsonb),
    timeout_milliseconds := _timeout_ms
  ) INTO v_req;

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.cron_invoke(text, jsonb, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cron_invoke(text, jsonb, text, integer) FROM anon, authenticated;

-- 3. Repoint every scheduled HTTP job at the helper (same schedules, same bodies).
SELECT cron.schedule('budget-sync-every-15m', '*/15 * * * *',
  $cron$SELECT public.cron_invoke('budget-sync', '{"providers":["github","supabase","lovable"]}'::jsonb);$cron$);

SELECT cron.schedule('weekly-security-audit', '0 6 * * 1',
  $cron$SELECT public.cron_invoke('security-audit');$cron$);

SELECT cron.schedule('reconcile-nih-pis-daily', '0 7 * * *',
  $cron$SELECT public.cron_invoke('nih-grants', '{"trigger":"daily_cron"}'::jsonb, 'action=reconcile');$cron$);

SELECT cron.schedule('ember-dandiset-sync-daily', '17 4 * * *',
  $cron$SELECT public.cron_invoke('ember-dandiset-sync');$cron$);

SELECT cron.schedule('embed-knowledge-freshness', '0 3 * * *',
  $cron$SELECT public.cron_invoke('embed-knowledge', jsonb_build_object('limit', 80));$cron$);

SELECT cron.schedule('device-knowledge-seed-nightly', '17 4 * * *',
  $cron$SELECT public.cron_invoke('device-knowledge-seed', jsonb_build_object('scheduled', true));$cron$);

SELECT cron.schedule('news-radar-nightly', '42 3 * * *',
  $cron$SELECT public.cron_invoke('news-radar-poll', jsonb_build_object('trigger', 'cron', 'at', now()));$cron$);