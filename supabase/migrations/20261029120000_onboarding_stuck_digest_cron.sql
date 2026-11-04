-- Email the DCAIC admins a digest of stuck onboarding steps every Monday, 13:00 UTC
-- (9 AM EDT / 8 AM EST). is_stuck was computed but nobody was told; see
-- supabase/functions/onboarding-stuck-digest. cron_invoke authenticates with the service-role key.
--
-- Apply MANUALLY in the KG SQL editor (vpexxhfpvghlejljwpvt), after deploying the function.

SELECT public.set_actor('migration:20261029_onboarding_stuck_digest_cron');

SELECT cron.schedule('onboarding-stuck-digest-weekly', '0 13 * * 1',
  $cron$SELECT public.cron_invoke('onboarding-stuck-digest');$cron$);

-- Verify: one job, Mondays 13:00 UTC.
SELECT jobname, schedule, command, active FROM cron.job WHERE jobname = 'onboarding-stuck-digest-weekly';
