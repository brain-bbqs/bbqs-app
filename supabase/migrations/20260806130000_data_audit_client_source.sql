-- Sharper provenance (Constitution Principle X): record WHICH CLIENT made each write, not
-- just the actor. Today data_audit_log captures actor_id + actor_role, but the agent, the
-- admin console, the member profile pane, and the Google-Form import all write under the
-- same user JWT (actor_role = 'authenticated'), so "who typed 'Analytics'?" could only be
-- INFERRED (bug 2026-08-06). This adds a client_source column populated from a request
-- header, so the audit answers "which surface" directly.
--
-- Mechanism: a client sets the HTTP header `X-BBQS-Client: <name>` on its PostgREST writes;
-- PostgREST exposes request headers to the transaction as the `request.headers` GUC, which
-- the SECURITY DEFINER trigger reads. Non-HTTP paths (SQL editor, cron) may instead
-- `set local app.client_source = '<name>'`. Absent both → 'unknown' (degrades gracefully;
-- pre-existing rows stay NULL). Suggested values: 'bbqs-agent', 'kg-site', 'form-import'.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor
-- (project vpexxhfpvghlejljwpvt).

ALTER TABLE public.data_audit_log ADD COLUMN IF NOT EXISTS client_source text;

CREATE OR REPLACE FUNCTION public.log_data_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _actor   uuid := auth.uid();
  _role    text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', 'unknown');
  -- Which CLIENT: prefer the X-BBQS-Client request header (PostgREST lowercases header
  -- names), then a session GUC for non-HTTP callers, else 'unknown'.
  _client  text := coalesce(
                     nullif(current_setting('request.headers', true)::jsonb ->> 'x-bbqs-client', ''),
                     nullif(current_setting('app.client_source', true), ''),
                     'unknown'
                   );
  _rec_id  text;
  _changed jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.data_audit_log(table_name, record_id, operation, actor_id, actor_role, client_source, old_data)
    VALUES (TG_TABLE_NAME, (to_jsonb(OLD) ->> 'id'), 'DELETE', _actor, _role, _client, to_jsonb(OLD));
    RETURN OLD;

  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.data_audit_log(table_name, record_id, operation, actor_id, actor_role, client_source, new_data)
    VALUES (TG_TABLE_NAME, (to_jsonb(NEW) ->> 'id'), 'INSERT', _actor, _role, _client, to_jsonb(NEW));
    RETURN NEW;

  ELSE  -- UPDATE: log only the fields that actually changed (ignore updated_at churn)
    SELECT jsonb_object_agg(o.key, jsonb_build_object('old', o.value, 'new', n.value))
      INTO _changed
      FROM jsonb_each(to_jsonb(OLD)) o
      JOIN jsonb_each(to_jsonb(NEW)) n ON n.key = o.key
     WHERE o.value IS DISTINCT FROM n.value
       AND o.key <> 'updated_at';
    IF _changed IS NULL THEN
      RETURN NEW;  -- nothing meaningful changed
    END IF;
    INSERT INTO public.data_audit_log(table_name, record_id, operation, actor_id, actor_role, client_source, changed_fields, old_data, new_data)
    VALUES (TG_TABLE_NAME, (to_jsonb(NEW) ->> 'id'), 'UPDATE', _actor, _role, _client, _changed, to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  END IF;
END;
$$;
