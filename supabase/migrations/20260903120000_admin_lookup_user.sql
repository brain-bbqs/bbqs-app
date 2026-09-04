-- Admin identity lookup: resolve a user_id or email to who it is, including accounts with no
-- investigators profile — the one identity question RLS cannot answer, because that identity lives
-- only in auth.users, which PostgREST does not expose.
--
-- SECURITY DEFINER so it can read auth.users, but gated on has_role(auth.uid(),'admin') FIRST, so
-- the elevation is spent only for a real admin and only on this one narrow read. This is why the
-- bbqs-mcp server still needs no service-role key: the privilege lives in a self-checking DB
-- function, not in the caller. Curators who are not admins get the exception, not data.
--
-- Reads only; nothing to log_data_change. Note there is no read-audit here — an admin resolving
-- identities leaves no trail, same as the Supabase dashboard's own Users view.
--
-- Apply MANUALLY in the KG SQL editor.

CREATE OR REPLACE FUNCTION public.admin_lookup_user(
  _user_id uuid  DEFAULT NULL,
  _email   text  DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid uuid := auth.uid();
  _u   record;
BEGIN
  IF NOT public.has_role(_uid, 'admin') THEN
    RAISE EXCEPTION 'Only admins can look up users by id or email';
  END IF;
  IF _user_id IS NULL AND (_email IS NULL OR btrim(_email) = '') THEN
    RAISE EXCEPTION 'Provide _user_id or _email';
  END IF;

  SELECT id, email, created_at, last_sign_in_at
    INTO _u
    FROM auth.users
   WHERE (_user_id IS NOT NULL AND id = _user_id)
      OR (_user_id IS NULL AND lower(email) = lower(btrim(_email)))
   LIMIT 1;

  IF _u.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'user_id', _u.id,
    'email', _u.email,
    'created_at', _u.created_at,
    'last_sign_in_at', _u.last_sign_in_at,
    'roles', (SELECT coalesce(jsonb_agg(role ORDER BY role), '[]'::jsonb)
                FROM public.user_roles WHERE user_id = _u.id),
    -- The bridge that decides whether this person is otherwise resolvable through the KG at all.
    'investigator', (SELECT jsonb_build_object('id', i.id, 'name', i.name, 'email', i.email)
                       FROM public.investigators i WHERE i.user_id = _u.id LIMIT 1)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_lookup_user(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_lookup_user(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.admin_lookup_user(uuid, text) IS
  'Admin-only identity resolver: user_id or email -> auth.users identity + roles + linked investigator, if any. SECURITY DEFINER to reach auth.users, gated on the caller being an admin. The bbqs-mcp whois tool wraps this.';

-- Confirm the function exists. It is NOT invoked here: the SQL editor runs with auth.uid() = NULL,
-- so calling it would (correctly) raise 'Only admins', which reads like a failed migration. Test it
-- through the whois tool as a signed-in admin instead.
SELECT proname, pg_get_function_identity_arguments(oid) AS args
  FROM pg_proc WHERE proname = 'admin_lookup_user';
