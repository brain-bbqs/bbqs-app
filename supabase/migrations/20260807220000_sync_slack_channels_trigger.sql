-- Slack channels follow working-group membership automatically.
--
-- Requirement: "if anyone is at any point added to any of the working groups, they should
-- automatically be added to the corresponding channels as well." Google Groups already work
-- this way (trg_sync_member_groups); this is the Slack counterpart, firing on the same events
-- so BOTH follow a profile edit no matter which surface made it (member, curator, agent,
-- console, or a SQL backfill).
--
-- The edge function ignores everything in the body except the email: it re-reads the member
-- with the service role and syncs from what the DATABASE says, so this call cannot be used to
-- grant channels that the record does not justify.
--
-- Requires: supabase functions deploy slack-channels, and SLACK_WG_CHANNELS configured.
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor.

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.sync_slack_channels()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RETURN NEW;   -- no email → nothing to resolve in Slack
  END IF;

  PERFORM net.http_post(
    url := 'https://vpexxhfpvghlejljwpvt.supabase.co/functions/v1/slack-channels',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwZXh4aGZwdmdobGVqbGp3cHZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk3MDg2NDUsImV4cCI6MjA4NTI4NDY0NX0.M107rJ9Ji17zAyd8Jolt5GQFZmu9vvAG1UiIq0GQh8U"}'::jsonb,
    body := jsonb_build_object('email', NEW.email, 'action', 'sync')
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A Slack failure must NEVER block the profile edit from saving.
  RAISE WARNING 'sync_slack_channels failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- Fires on the same conditions as the Google-Group sync, plus INSERT: a member created with
-- working groups already set would otherwise never be synced (the Google-Group trigger has
-- exactly that gap — it is UPDATE-only, which is why group-audit found drift).
DROP TRIGGER IF EXISTS trg_sync_slack_channels ON public.investigators;
CREATE TRIGGER trg_sync_slack_channels
  AFTER INSERT OR UPDATE ON public.investigators
  FOR EACH ROW
  WHEN (
    TG_OP = 'INSERT'
    OR OLD.working_groups IS DISTINCT FROM NEW.working_groups
    OR OLD.role IS DISTINCT FROM NEW.role
  )
  EXECUTE FUNCTION public.sync_slack_channels();
