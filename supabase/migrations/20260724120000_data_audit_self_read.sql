-- Let a member read THEIR OWN provenance entries (the "Data Provenance (Your Edits)"
-- section on the profile page reads data_audit_log filtered by actor_id = auth.uid()).
-- Additive to the curator/admin read policy from 20260723120000; still append-only
-- (no INSERT/UPDATE/DELETE policy — rows are written only by the SECURITY DEFINER trigger).
-- Run in the KG SQL editor (project vpexxhfpvghlejljwpvt).

DROP POLICY IF EXISTS "actors read own data audit" ON public.data_audit_log;
CREATE POLICY "actors read own data audit"
  ON public.data_audit_log FOR SELECT TO authenticated
  USING (actor_id = auth.uid());
