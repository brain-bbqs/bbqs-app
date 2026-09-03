-- Route trg_sync_member_groups through cron_invoke so it authenticates to the now-gated
-- sync-member-groups edge function.
--
-- sync-member-groups makes privileged Google Directory writes and now rejects unauthenticated
-- callers (verify_jwt stays false; the handler gates itself). It accepts the service-role key or a
-- signed-in admin/curator JWT. This trigger previously posted the PUBLIC anon key as `apikey` with
-- no Authorization header, so under the new gate it would 401. public.cron_invoke pulls the
-- service-role key from the vault (secret `project_service_role_key`) and sends it in Authorization,
-- exactly as every other scheduled job does — so the trigger presents a trusted machine credential
-- without hardcoding a secret in this file. Body (email + old/new delta) is unchanged.
--
-- PRECONDITION: vault secret `project_service_role_key` must be set on this project. cron_invoke
-- falls back to the anon key when it is absent, and the anon key would be rejected by the gate — the
-- sync would then silently no-op (the trigger swallows errors to never block the profile edit).
-- Verify with:  SELECT name FROM vault.secrets WHERE name = 'project_service_role_key';
--
-- Apply manually in the SQL editor for project vpexxhfpvghlejljwpvt (KG migrations are never
-- db push'd), together with: supabase functions deploy sync-member-groups --project-ref vpexxhfpvghlejljwpvt

CREATE OR REPLACE FUNCTION public.sync_member_groups()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Nothing to sync without an email to key the Google membership on.
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RETURN NEW;
  END IF;

  PERFORM public.cron_invoke(
    'sync-member-groups',
    jsonb_build_object(
      'email', NEW.email,
      'old', jsonb_build_object('working_groups', OLD.working_groups, 'role', OLD.role),
      'new', jsonb_build_object('working_groups', NEW.working_groups, 'role', NEW.role)
    )
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A sync failure must NEVER block the profile edit from saving.
  RAISE WARNING 'sync_member_groups failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
