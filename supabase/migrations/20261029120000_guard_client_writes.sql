-- RLS on investigators and grant_investigators is row-level only, so a member could rewrite any column
-- of a row they may edit: set pending_role='admin' (globus-auth promotes it at next sign-in), change
-- role/working_groups/email (trg_sync_member_groups adds the result to Google Groups), or claim another
-- person's email as a secondary (globus-auth signs that person into the member's account). On the
-- roster, any roster member could make themselves contact_pi (pi@).
--
-- The guards restrict only DIRECT client writes, recognised by current_user: PostgREST writes run as
-- `authenticated`, while SECURITY DEFINER RPCs (member_self_update, onboard_member, ...) run as their
-- owner and service-role writes as `service_role`, and those check authority themselves.

SELECT public.set_actor('migration:guard_client_writes');

CREATE OR REPLACE FUNCTION public.guard_investigator_client_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $fn$
DECLARE
  _uid uuid := auth.uid();
  _self_editable text[] := ARRAY['name', 'orcid', 'scholar_id', 'profile_url', 'institution',
    'research_areas', 'skills', 'requested_working_groups', 'birthday', 'updated_at'];
  _changed text[];
BEGIN
  IF NEW.pending_role IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.pending_role END)
     AND NEW.pending_role = 'admin' AND _uid IS NOT NULL AND NOT public.has_role(_uid, 'admin') THEN
    RAISE EXCEPTION 'only an admin can grant admin' USING ERRCODE = '42501';
  END IF;

  IF current_user NOT IN ('authenticated', 'anon') OR public.is_curator_or_admin(_uid) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'only curators can add people' USING ERRCODE = '42501';
  END IF;

  SELECT array_agg(n.key) INTO _changed
  FROM jsonb_each(to_jsonb(NEW)) n
  JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
  WHERE n.value IS DISTINCT FROM o.value AND n.key <> ALL (_self_editable);

  -- Claiming one's own unclaimed record (useInvestigatorOwnership).
  IF _changed = ARRAY['user_id'] AND OLD.user_id IS NULL AND NEW.user_id = _uid
     AND lower(coalesce(auth.jwt() ->> 'email', '')) IN (
       SELECT lower(e) FROM unnest(array_append(coalesce(OLD.secondary_emails, '{}'), OLD.email)) e) THEN
    RETURN NEW;
  END IF;

  IF _changed IS NOT NULL THEN
    RAISE EXCEPTION 'only curators can change %', array_to_string(_changed, ', ') USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $fn$;

-- SECURITY DEFINER: it has to see other people's rows, which the caller's RLS hides. A trigger function
-- cannot be called directly, so this is not an email-lookup oracle.
CREATE OR REPLACE FUNCTION public.guard_secondary_emails()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _uid uuid := auth.uid();
  _taken text;
BEGIN
  IF _uid IS NULL OR public.is_curator_or_admin(_uid) THEN
    RETURN NEW;
  END IF;
  SELECT e INTO _taken
  FROM unnest(coalesce(NEW.secondary_emails, '{}')) e
  WHERE lower(e) NOT IN (SELECT lower(x) FROM unnest(coalesce(
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.secondary_emails END, '{}')) x)
    AND EXISTS (
      SELECT 1 FROM public.investigators i
      WHERE i.id <> NEW.id
        AND (lower(i.email) = lower(e)
             OR lower(e) IN (SELECT lower(y) FROM unnest(coalesce(i.secondary_emails, '{}')) y)))
  LIMIT 1;
  IF _taken IS NOT NULL THEN
    RAISE EXCEPTION '% belongs to another member; ask a curator to merge the records', _taken
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $fn$;

REVOKE ALL ON FUNCTION public.guard_secondary_emails() FROM PUBLIC, anon, authenticated;

-- "trg_aa_": BEFORE triggers fire in name order, and this one must see the client's row before other
-- triggers (zodiac, onboarding stamps, updated_at) fill in derived columns.
DROP TRIGGER IF EXISTS trg_aa_guard_investigator_client_write ON public.investigators;
CREATE TRIGGER trg_aa_guard_investigator_client_write
  BEFORE INSERT OR UPDATE ON public.investigators
  FOR EACH ROW EXECUTE FUNCTION public.guard_investigator_client_write();

DROP TRIGGER IF EXISTS trg_aa_guard_secondary_emails ON public.investigators;
CREATE TRIGGER trg_aa_guard_secondary_emails
  BEFORE INSERT OR UPDATE OF secondary_emails ON public.investigators
  FOR EACH ROW EXECUTE FUNCTION public.guard_secondary_emails();

CREATE OR REPLACE FUNCTION public.guard_roster_client_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $fn$
DECLARE
  _uid uuid := auth.uid();
  _pi text[] := ARRAY['pi', 'contact_pi', 'co_pi', 'mpi'];
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') OR public.is_curator_or_admin(_uid) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF lower(OLD.role) = ANY (_pi) THEN
      RAISE EXCEPTION 'only curators can remove a PI from a roster' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF lower(NEW.role) = ANY (_pi) THEN
      RAISE EXCEPTION 'only curators can assign a PI role' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.grant_id IS DISTINCT FROM OLD.grant_id OR NEW.investigator_id IS DISTINCT FROM OLD.investigator_id THEN
    RAISE EXCEPTION 'only curators can move a roster entry' USING ERRCODE = '42501';
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role AND (
       lower(OLD.role) = ANY (_pi) OR lower(NEW.role) = ANY (_pi)
       OR EXISTS (SELECT 1 FROM public.investigators i WHERE i.id = NEW.investigator_id AND i.user_id = _uid)) THEN
    RAISE EXCEPTION 'only curators can assign or change a PI role, or change their own' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $fn$;

-- After trg_normalize_grant_role ("r" > "n"), so the role is already canonical.
DROP TRIGGER IF EXISTS trg_roster_client_write_guard ON public.grant_investigators;
CREATE TRIGGER trg_roster_client_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.grant_investigators
  FOR EACH ROW EXECUTE FUNCTION public.guard_roster_client_write();
