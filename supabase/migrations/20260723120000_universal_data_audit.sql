-- Universal data provenance (Constitution Principle X, broadened in v1.7.0).
--
-- Every modification to consortium/user data must be attributable — by the agent, an
-- admin/curator via the console, OR a member editing their own profile. App-level logs
-- (the agent's pending_writes/audit, curation_audit_log) only cover the paths they own,
-- so direct client edits (profile pane, admin console) went unlogged. This adds the
-- FLOOR: a database-level append-only audit trigger, keyed on auth.uid(), that captures
-- actor + time + operation + before/after for INSERT/UPDATE/DELETE on every user-data
-- table — regardless of which client made the write. "Who changed this row, what
-- changed, how many times, and when" is then answerable by querying data_audit_log.
--
-- KG migrations are NOT applied by `db push` — run this in the KG SQL editor
-- (project vpexxhfpvghlejljwpvt).

-- ── 1. Append-only audit store ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.data_audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name     text        NOT NULL,
  record_id      text,                       -- NEW/OLD.id when the table has one
  operation      text        NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  actor_id       uuid,                        -- auth.uid() of whoever made the write
  actor_role     text,                        -- JWT role claim (authenticated / service_role / …)
  changed_fields jsonb,                       -- {col: {old, new}} for UPDATE (excludes updated_at)
  old_data       jsonb,
  new_data       jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_audit_record
  ON public.data_audit_log (table_name, record_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_audit_actor
  ON public.data_audit_log (actor_id, occurred_at DESC);

-- Append-only + least privilege: writes happen ONLY via the SECURITY DEFINER trigger
-- below (never directly). Curators/admins may read the trail; nobody updates/deletes it.
ALTER TABLE public.data_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "curators read data audit" ON public.data_audit_log;
CREATE POLICY "curators read data audit"
  ON public.data_audit_log FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'curator'));

-- ── 2. Generic capture function ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_data_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _actor   uuid := auth.uid();
  _role    text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', 'unknown');
  _rec_id  text;
  _changed jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.data_audit_log(table_name, record_id, operation, actor_id, actor_role, old_data)
    VALUES (TG_TABLE_NAME, (to_jsonb(OLD) ->> 'id'), 'DELETE', _actor, _role, to_jsonb(OLD));
    RETURN OLD;

  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.data_audit_log(table_name, record_id, operation, actor_id, actor_role, new_data)
    VALUES (TG_TABLE_NAME, (to_jsonb(NEW) ->> 'id'), 'INSERT', _actor, _role, to_jsonb(NEW));
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
    INSERT INTO public.data_audit_log(table_name, record_id, operation, actor_id, actor_role, changed_fields, old_data, new_data)
    VALUES (TG_TABLE_NAME, (to_jsonb(NEW) ->> 'id'), 'UPDATE', _actor, _role, _changed, to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  END IF;
END;
$$;

-- ── 3. Attach to every user-data table ────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'investigators', 'grant_investigators', 'grants', 'projects',
    'publications', 'project_publications', 'resources', 'organizations',
    'investigator_organizations', 'funding_opportunities', 'jobs',
    'announcements', 'access_requests'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%1$s ON public.%1$I;', t);
      EXECUTE format(
        'CREATE TRIGGER trg_audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I '
        || 'FOR EACH ROW EXECUTE FUNCTION public.log_data_change();', t);
    END IF;
  END LOOP;
END $$;
