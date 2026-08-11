-- Provenance: fix ATTRIBUTION and COVERAGE, not column count.
--
-- An earlier draft of this migration added created_at/updated_at/updated_by/updated_via to 53
-- tables. That was the wrong fix, and the reason is worth writing down: this database ALREADY has a
-- provenance tracker. `log_data_change` writes every INSERT/UPDATE/DELETE to data_audit_log with
-- old_data, new_data, changed_fields, a timestamp and an actor — strictly MORE than an updated_by
-- column can hold, since it keeps the previous value too. It is already attached to the 13 core
-- entity tables, `grant_investigators` among them. So per-table updated_by would have duplicated
-- the log on the tables that had it and still told us nothing new.
--
-- What actually failed in the contact_pi case (1R61MH138967: two contact_pi rows, Neimat promoted
-- co_pi -> contact_pi on 2026-08-08 21:23:05) was not a missing row. The row was there, with both
-- values and the timestamp. Two things were missing:
--
--   1. ATTRIBUTION. 479 audit rows, 104 with an actor_id, 375 NULL (78%) — investigators alone is
--      333/413 (81%), and grant_investigators 18/31, the contact_pi rows among them. auth.uid() is
--      NULL for service-role edge functions, the SQL editor and migrations, which is most writes
--      here. client_source was meant to cover this and is 'unknown' or NULL on ALL 479 rows: it read
--      the X-BBQS-Client header, removed after it broke every edge function's CORS preflight, so it
--      has never once been populated. A per-table updated_by would have inherited this exact hole.
--
--   2. COVERAGE. 49 tables have no audit trigger. Most should not have one (telemetry, machine
--      output, append-only logs — logging a full old/new jsonb pair on analytics_pageviews would
--      cost more than it tells us). But several HUMAN-CURATED tables are unaudited, and one is
--      security-critical: user_roles, where an admin or curator grant currently leaves no trace at
--      all. allowed_domains is the same shape.
--
-- So: give every write an attributable label, extend the tracker to the curated tables, and add
-- created_at/updated_at only where they are genuinely absent — those two are cheap and let a UI sort
-- or display "last changed" without joining the audit log. No updated_by, no updated_via.
--
-- KG migrations are NOT applied by db push — run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

-- ── 1. Attribution ────────────────────────────────────────────────────────────────────────────
-- Transaction-local actor label, for writes where auth.uid() is NULL. Deliberately NOT a session
-- default: it must be re-declared per transaction, so a stale label can never be attributed to
-- unrelated later work.
CREATE OR REPLACE FUNCTION public.set_actor(_label text)
RETURNS text LANGUAGE sql VOLATILE AS $fn$
  SELECT set_config('app.actor', coalesce(nullif(btrim(_label), ''), 'unknown'), true)
$fn$;

COMMENT ON FUNCTION public.set_actor(text) IS
  'Names the agent performing the current transaction, for writes where auth.uid() is NULL (service role, SQL editor, migrations). Transaction-local; read by log_data_change(). Convention: every migration and every service-role edge function calls this first.';

CREATE OR REPLACE FUNCTION public.current_actor_via()
RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(
    nullif(current_setting('app.actor', true), ''),
    nullif(current_setting('request.headers', true)::jsonb ->> 'x-bbqs-client', ''),
    CASE WHEN auth.uid() IS NOT NULL THEN 'authenticated-user' END,
    'unknown'
  )
$fn$;

GRANT EXECUTE ON FUNCTION public.set_actor(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_actor_via() TO authenticated, service_role;

SELECT public.set_actor('migration:20260810160000');

ALTER TABLE public.data_audit_log ADD COLUMN IF NOT EXISTS actor_label text;

COMMENT ON COLUMN public.data_audit_log.actor_label IS
  'Who/what performed the write when actor_id is NULL: the set_actor() label, else the client header, else authenticated-user, else unknown. Added because actor_id was NULL on 78% of rows, which is why the 1R61MH138967 contact_pi change could be dated but not attributed.';

CREATE OR REPLACE FUNCTION public.log_data_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _actor   uuid := auth.uid();
  _role    text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', 'unknown');
  _client  text := coalesce(
                     nullif(current_setting('request.headers', true)::jsonb ->> 'x-bbqs-client', ''),
                     nullif(current_setting('app.client_source', true), ''),
                     'unknown'
                   );
  _label   text := public.current_actor_via();
  _changed jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.data_audit_log(table_name, record_id, operation, actor_id, actor_role, client_source, actor_label, old_data)
    VALUES (TG_TABLE_NAME, (to_jsonb(OLD) ->> 'id'), 'DELETE', _actor, _role, _client, _label, to_jsonb(OLD));
    RETURN OLD;

  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.data_audit_log(table_name, record_id, operation, actor_id, actor_role, client_source, actor_label, new_data)
    VALUES (TG_TABLE_NAME, (to_jsonb(NEW) ->> 'id'), 'INSERT', _actor, _role, _client, _label, to_jsonb(NEW));
    RETURN NEW;

  ELSE  -- UPDATE: log only fields that actually changed; updated_at churn is not a change.
    SELECT jsonb_object_agg(o.key, jsonb_build_object('old', o.value, 'new', n.value))
      INTO _changed
      FROM jsonb_each(to_jsonb(OLD)) o
      JOIN jsonb_each(to_jsonb(NEW)) n ON n.key = o.key
     WHERE o.value IS DISTINCT FROM n.value
       AND o.key <> 'updated_at';
    IF _changed IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.data_audit_log(table_name, record_id, operation, actor_id, actor_role, client_source, actor_label, changed_fields, old_data, new_data)
    VALUES (TG_TABLE_NAME, (to_jsonb(NEW) ->> 'id'), 'UPDATE', _actor, _role, _client, _label, _changed, to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  END IF;
END;
$fn$;

-- ── 2. created_at / updated_at where genuinely missing ────────────────────────────────────────
-- Only these 7 lack created_at (data_audit_log also does, but it is append-only and has occurred_at).
-- All are small (largest: budget_snapshots at 5,704 rows), so the NOT NULL rewrite is trivial.
DO $do$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'budget_snapshots', 'cohort_summaries', 'grant_investigators', 'group_audit_dismissals',
    'harvester_settings', 'investigator_organizations', 'personality_scores'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS update_%s_updated_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER update_%s_updated_at BEFORE UPDATE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t, t);
  END LOOP;
END
$do$;

-- Tables that already had created_at but no updated_at.
DO $do$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'allowed_domains', 'feature_votes', 'grant_dandisets', 'grant_methods_evidence',
    'grant_methods_traversal_paths', 'harvester_relations', 'harvester_synonyms',
    'organizations', 'project_publications', 'proposed_relations', 'publications', 'user_roles'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS update_%s_updated_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER update_%s_updated_at BEFORE UPDATE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t, t);
  END LOOP;
END
$do$;

-- ── 3. Extend the tracker to unaudited HUMAN-CURATED tables ───────────────────────────────────
-- user_roles first: granting admin or curator currently leaves no trace anywhere, which is the most
-- consequential untracked write in the database. allowed_domains gates who can register at all.
-- Deliberately NOT audited: analytics_*, search_queries, harvester_runs/queue, knowledge_embeddings,
-- budget_snapshots, news_candidates, proposed_relations, grant_methods_*, lovable_* and the
-- append-only logs — machine output or telemetry, where a full old/new jsonb pair per row would cost
-- more than it reveals.
DO $do$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'user_roles', 'allowed_domains', 'profiles', 'personality_scores', 'state_privacy_rules',
    'species', 'software_tools', 'dandisets', 'grant_dandisets', 'budget_config',
    'device_categories', 'device_manufacturers', 'device_models', 'device_class_crosswalk',
    'device_category_parameters', 'device_category_pitfalls', 'device_category_references',
    'device_category_ml_specs', 'entity_comments', 'feature_suggestions', 'feature_votes',
    'group_audit_dismissals', 'harvester_settings', 'harvester_keywords', 'harvester_synonyms',
    'working_group_dashboard_defaults'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%s ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_audit_%s AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.log_data_change()', t, t);
  END LOOP;
END
$do$;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Audit coverage: expect ~39 audited tables (13 existing + 26 added).
SELECT count(*) AS audited_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND t.tgname LIKE 'trg_audit%');

-- 2) Any table still lacking created_at or updated_at (append-only logs excluded).
SELECT c.relname AS table_name,
       bool_or(a.attname = 'created_at') AS created_at,
       bool_or(a.attname = 'updated_at') AS updated_at
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND c.relname NOT IN ('data_audit_log', 'auth_audit_log', 'curation_audit_log', 'edit_history',
                         'analytics_clicks', 'analytics_pageviews', 'search_queries',
                         'security_audit_results', 'lovable_credit_events')
 GROUP BY c.relname
HAVING NOT (bool_or(a.attname = 'created_at') AND bool_or(a.attname = 'updated_at'))
 ORDER BY 1;

-- 3) Attribution is live: this row should show actor_label = 'migration:20260810160000'.
SELECT table_name, operation, actor_id, actor_label, occurred_at
  FROM public.data_audit_log
 ORDER BY occurred_at DESC
 LIMIT 5;
