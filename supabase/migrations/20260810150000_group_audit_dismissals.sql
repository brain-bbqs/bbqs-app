-- Dismissals for the Google Group audit's "in the group but NOT entitled" list.
--
-- WHY. The audit re-derives entitlement from live state on every run, so an entry an admin has
-- already judged acceptable comes back every single time. With no way to record that judgement the
-- only two options are "remove" or "keep re-reading the same list", which pushes an admin toward
-- removing people just to clear the screen. That is the wrong pressure: the entries most likely to
-- recur are precisely the ambiguous ones.
--
-- The concrete case (2026-08-10): young-investigators@ flagged 10 addresses / 9 people, 8 labelled
-- "Research Staff (Scientist and others)". That label is a form catch-all that cannot distinguish a
-- second-year research scientist from a 20-year staff scientist, so it can neither entitle nor
-- convict. young-investigators@ is a career-development community list, not an authority list like
-- pi@ -- being wrongly on pi@ misrepresents who speaks for a project, while being on a mentoring
-- list protects nothing by being removed. "Reviewed, leave them" needed somewhere to live.
--
-- ROLE-CHANGE RESURFACING. A dismissal records the role the person held when it was made. It
-- silences that entry only while the role is unchanged: if the role later changes, the entry
-- returns to the review list, because the judgement was made about a person the KG described
-- differently. This is why the table stores role_at_dismissal rather than a bare boolean -- a
-- permanent mute would quietly outlive its own reasoning.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

CREATE TABLE IF NOT EXISTS public.group_audit_dismissals (
  group_email       text        NOT NULL,
  member_email      text        NOT NULL,
  role_at_dismissal text,                    -- NULL = dismissed while the KG had no role for them
  reason            text,
  dismissed_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  dismissed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_email, member_email)
);

COMMENT ON TABLE public.group_audit_dismissals IS
  'Admin judgements that a Google Group member flagged as un-entitled may stay. Keyed by (group, member); silences the entry only while the member''s KG role still matches role_at_dismissal, so a role change resurfaces it for review.';

ALTER TABLE public.group_audit_dismissals ENABLE ROW LEVEL SECURITY;

-- Admin/curator only: this records a decision about another member's mailing-list access.
DROP POLICY IF EXISTS group_audit_dismissals_read ON public.group_audit_dismissals;
CREATE POLICY group_audit_dismissals_read ON public.group_audit_dismissals
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator'));

-- Writes go through the RPCs below (SECURITY DEFINER), which capture the current role. No direct
-- INSERT/UPDATE/DELETE policy exists, so a client cannot forge role_at_dismissal and thereby make
-- a dismissal that never resurfaces.

-- Dismiss one (group, member) pair, stamping the member's CURRENT KG role.
CREATE OR REPLACE FUNCTION public.dismiss_group_audit_entry(
  _group_email  text,
  _member_email text,
  _reason       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid  uuid := auth.uid();
  _g    text := lower(btrim(_group_email));
  _m    text := lower(btrim(_member_email));
  _role text;
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can dismiss audit entries';
  END IF;
  IF _g = '' OR _m = '' THEN RAISE EXCEPTION 'Both a group and a member address are required'; END IF;

  -- Match on primary OR secondary address: the audit reports by ADDRESS, and a member may sit in
  -- the group under an alternate one (dima@basis.ai vs the gmail secondary).
  SELECT i.role INTO _role
    FROM public.investigators i
   WHERE lower(btrim(i.email)) = _m
      OR EXISTS (SELECT 1 FROM unnest(coalesce(i.secondary_emails, '{}')) s WHERE lower(btrim(s)) = _m)
   LIMIT 1;

  INSERT INTO public.group_audit_dismissals (group_email, member_email, role_at_dismissal, reason, dismissed_by)
  VALUES (_g, _m, _role, nullif(btrim(_reason), ''), _uid)
  ON CONFLICT (group_email, member_email) DO UPDATE
    SET role_at_dismissal = excluded.role_at_dismissal,
        reason            = coalesce(excluded.reason, public.group_audit_dismissals.reason),
        dismissed_by      = excluded.dismissed_by,
        dismissed_at      = now();

  RETURN jsonb_build_object('ok', true, 'group_email', _g, 'member_email', _m, 'role_at_dismissal', _role);
END;
$$;

-- Undo a dismissal, returning the entry to the review list.
CREATE OR REPLACE FUNCTION public.undismiss_group_audit_entry(
  _group_email  text,
  _member_email text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _n   int;
BEGIN
  IF NOT (public.has_role(_uid, 'admin') OR public.has_role(_uid, 'curator')) THEN
    RAISE EXCEPTION 'Only admins or curators can undo audit dismissals';
  END IF;
  DELETE FROM public.group_audit_dismissals
   WHERE group_email = lower(btrim(_group_email))
     AND member_email = lower(btrim(_member_email));
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'removed', _n);
END;
$$;

-- Live dismissals, with the member's CURRENT role alongside the stamped one so the audit (and a
-- human) can see which dismissals have gone stale.
CREATE OR REPLACE VIEW public.group_audit_dismissals_live
WITH (security_invoker = true)
AS
SELECT d.group_email,
       d.member_email,
       d.role_at_dismissal,
       i.role AS current_role,
       i.name AS member_name,
       (coalesce(i.role, '') IS DISTINCT FROM coalesce(d.role_at_dismissal, '')) AS role_changed,
       d.reason,
       d.dismissed_at
  FROM public.group_audit_dismissals d
  LEFT JOIN public.investigators i
         ON lower(btrim(i.email)) = d.member_email
         OR EXISTS (SELECT 1 FROM unnest(coalesce(i.secondary_emails, '{}')) s WHERE lower(btrim(s)) = d.member_email);

COMMENT ON VIEW public.group_audit_dismissals_live IS
  'Dismissals joined to the member''s current KG role. role_changed = true means the dismissal is stale and the entry should be reviewed again.';

GRANT EXECUTE ON FUNCTION public.dismiss_group_audit_entry(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.undismiss_group_audit_entry(text, text) TO authenticated;
GRANT SELECT ON public.group_audit_dismissals_live TO authenticated;
