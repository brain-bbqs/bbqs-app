-- Universal provenance: created_at / updated_at / updated_by / updated_via on every table.
--
-- WHY, precisely. The two contact_pi rows on 1R61MH138967 could be dated to the second
-- (2026-08-08 21:23:05, co_pi -> contact_pi) but NOT attributed -- and not because the audit trail
-- was missing. data_audit_log held the row, the old value, the new value and the timestamp. What it
-- lacked was WHO, and an updated_by column alone would NOT have supplied it:
--
--   data_audit_log, measured 2026-08-10: 479 rows, 104 with actor_id, 375 NULL (78%)
--     investigators        413 rows -> 333 NULL actor_id (81%)
--     grant_investigators   31 rows ->  18 NULL actor_id (the contact_pi rows among them)
--   client_source is 'unknown' or NULL on ALL 479 rows: it read the X-BBQS-Client header, which was
--   removed after it broke every edge function's CORS preflight, so it has never once been set.
--
-- auth.uid() is NULL for service-role edge functions, for the SQL editor, and inside migrations --
-- the majority of writes here. So a bare updated_by uuid reproduces the same hole: a column that is
-- NULL for precisely the writes whose origin is unclear.
--
-- Hence FOUR columns. updated_by holds a real user when one exists; updated_via always holds
-- something, from a transaction-local label the caller sets:
--
--     SELECT public.set_actor('migration:20260810160000');   -- top of a migration
--     SELECT public.set_actor('group-audit');                -- service-role edge function
--
-- An unlabelled write still records 'unknown', but that is now a deliberate gap rather than the
-- default, and every path we control can close it.
--
-- SCOPE: every table except the append-only logs and telemetry listed here, which are never
-- UPDATEd and already carry their own timestamp and actor:
--   analytics_clicks, analytics_pageviews, auth_audit_log, curation_audit_log, data_audit_log, edit_history, lovable_credit_events, search_queries, security_audit_results
-- data_audit_log instead gains actor_label, so the label reaches the audit trail too.
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

-- Transaction-local actor label. Deliberately NOT a session default: it must be re-declared per
-- transaction, so a stale label can never be attributed to unrelated later work.
CREATE OR REPLACE FUNCTION public.set_actor(_label text)
RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT set_config('app.actor', coalesce(nullif(btrim(_label), ''), 'unknown'), true)
$$;

COMMENT ON FUNCTION public.set_actor(text) IS
  'Names the agent performing the current transaction, for writes where auth.uid() is NULL (service role, SQL editor, migrations). Transaction-local. Read by touch_provenance() and log_data_change().';

-- Resolve the best available label, never failing.
CREATE OR REPLACE FUNCTION public.current_actor_via()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('app.actor', true), ''),
    nullif(current_setting('request.headers', true)::jsonb ->> 'x-bbqs-client', ''),
    CASE WHEN auth.uid() IS NOT NULL THEN 'authenticated-user' END,
    'unknown'
  )
$$;

-- One trigger for every table: stamp updated_at and record who/what did it.
CREATE OR REPLACE FUNCTION public.touch_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();                  -- NULL for service-role / SQL-editor writes
  NEW.updated_via := public.current_actor_via();
  RETURN NEW;
END;
$$;

-- Carry the label into the audit trail too, so history stays attributable even after the row's own
-- updated_via has been overwritten by a later edit.
ALTER TABLE public.data_audit_log ADD COLUMN IF NOT EXISTS actor_label text;

CREATE OR REPLACE FUNCTION public.log_data_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  ELSE  -- UPDATE: log only fields that actually changed. updated_at/_by/_via are provenance rather
        -- than content, so they must never count as a change on their own or every touch logs itself.
    SELECT jsonb_object_agg(o.key, jsonb_build_object('old', o.value, 'new', n.value))
      INTO _changed
      FROM jsonb_each(to_jsonb(OLD)) o
      JOIN jsonb_each(to_jsonb(NEW)) n ON n.key = o.key
     WHERE o.value IS DISTINCT FROM n.value
       AND o.key NOT IN ('updated_at', 'updated_by', 'updated_via');
    IF _changed IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.data_audit_log(table_name, record_id, operation, actor_id, actor_role, client_source, actor_label, changed_fields, old_data, new_data)
    VALUES (TG_TABLE_NAME, (to_jsonb(NEW) ->> 'id'), 'UPDATE', _actor, _role, _client, _label, _changed, to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_actor(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_actor_via() TO authenticated, service_role;

SELECT public.set_actor('migration:20260810160000');

-- ---------------------------------------------------------------------------------------------
-- Columns + touch trigger, table by table. Idempotent: ADD COLUMN IF NOT EXISTS, and a DROP before
-- each CREATE TRIGGER, so re-running is safe.


-- access_requests
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.access_requests;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.access_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- allowed_domains
ALTER TABLE public.allowed_domains ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.allowed_domains ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.allowed_domains ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.allowed_domains;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.allowed_domains
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- announcements
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.announcements;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- budget_config
ALTER TABLE public.budget_config ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.budget_config;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.budget_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- budget_snapshots
ALTER TABLE public.budget_snapshots ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.budget_snapshots ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.budget_snapshots ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.budget_snapshots ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.budget_snapshots;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.budget_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- cohort_summaries
ALTER TABLE public.cohort_summaries ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.cohort_summaries ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.cohort_summaries ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.cohort_summaries ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.cohort_summaries;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.cohort_summaries
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- dandisets
ALTER TABLE public.dandisets ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.dandisets ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.dandisets;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.dandisets
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- device_categories
ALTER TABLE public.device_categories ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.device_categories ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.device_categories;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.device_categories
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- device_category_ml_specs
ALTER TABLE public.device_category_ml_specs ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.device_category_ml_specs ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.device_category_ml_specs;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.device_category_ml_specs
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- device_category_parameters
ALTER TABLE public.device_category_parameters ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.device_category_parameters ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.device_category_parameters;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.device_category_parameters
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- device_category_pitfalls
ALTER TABLE public.device_category_pitfalls ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.device_category_pitfalls ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.device_category_pitfalls;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.device_category_pitfalls
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- device_category_references
ALTER TABLE public.device_category_references ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.device_category_references ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.device_category_references;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.device_category_references
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- device_class_crosswalk
ALTER TABLE public.device_class_crosswalk ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.device_class_crosswalk ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.device_class_crosswalk;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.device_class_crosswalk
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- device_manufacturers
ALTER TABLE public.device_manufacturers ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.device_manufacturers ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.device_manufacturers;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.device_manufacturers
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- device_models
ALTER TABLE public.device_models ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.device_models ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.device_models;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.device_models
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- entity_comments
ALTER TABLE public.entity_comments ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.entity_comments ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.entity_comments;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.entity_comments
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- feature_suggestions
ALTER TABLE public.feature_suggestions ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.feature_suggestions ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.feature_suggestions;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.feature_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- feature_votes
ALTER TABLE public.feature_votes ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.feature_votes ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.feature_votes ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.feature_votes;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.feature_votes
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- funding_opportunities
ALTER TABLE public.funding_opportunities ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.funding_opportunities ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.funding_opportunities;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.funding_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- grant_dandisets
ALTER TABLE public.grant_dandisets ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.grant_dandisets ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.grant_dandisets ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.grant_dandisets;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.grant_dandisets
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- grant_investigators
ALTER TABLE public.grant_investigators ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.grant_investigators ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.grant_investigators ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.grant_investigators ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.grant_investigators;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.grant_investigators
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- grant_methods_evidence
ALTER TABLE public.grant_methods_evidence ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.grant_methods_evidence ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.grant_methods_evidence ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.grant_methods_evidence;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.grant_methods_evidence
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- grant_methods_traversal_paths
ALTER TABLE public.grant_methods_traversal_paths ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.grant_methods_traversal_paths ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.grant_methods_traversal_paths ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.grant_methods_traversal_paths;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.grant_methods_traversal_paths
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- grants
ALTER TABLE public.grants ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.grants ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.grants;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.grants
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- group_audit_dismissals
ALTER TABLE public.group_audit_dismissals ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.group_audit_dismissals ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.group_audit_dismissals ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.group_audit_dismissals ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.group_audit_dismissals;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.group_audit_dismissals
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- harvester_keywords
ALTER TABLE public.harvester_keywords ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.harvester_keywords ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.harvester_keywords;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.harvester_keywords
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- harvester_queue
ALTER TABLE public.harvester_queue ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.harvester_queue ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.harvester_queue;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.harvester_queue
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- harvester_relations
ALTER TABLE public.harvester_relations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.harvester_relations ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.harvester_relations ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.harvester_relations;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.harvester_relations
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- harvester_runs
ALTER TABLE public.harvester_runs ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.harvester_runs ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.harvester_runs;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.harvester_runs
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- harvester_settings
ALTER TABLE public.harvester_settings ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.harvester_settings ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.harvester_settings;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.harvester_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- harvester_synonyms
ALTER TABLE public.harvester_synonyms ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.harvester_synonyms ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.harvester_synonyms ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.harvester_synonyms;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.harvester_synonyms
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- investigator_organizations
ALTER TABLE public.investigator_organizations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.investigator_organizations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.investigator_organizations ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.investigator_organizations ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.investigator_organizations;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.investigator_organizations
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- investigators
ALTER TABLE public.investigators ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.investigators ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.investigators;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.investigators
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- jobs
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.jobs;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- knowledge_embeddings
ALTER TABLE public.knowledge_embeddings ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.knowledge_embeddings ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.knowledge_embeddings;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.knowledge_embeddings
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- lovable_invoices
ALTER TABLE public.lovable_invoices ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.lovable_invoices ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.lovable_invoices;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.lovable_invoices
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- lovable_user_usage
ALTER TABLE public.lovable_user_usage ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.lovable_user_usage ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.lovable_user_usage;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.lovable_user_usage
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- news_candidates
ALTER TABLE public.news_candidates ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.news_candidates ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.news_candidates;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.news_candidates
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- organizations
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.organizations;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- personality_scores
ALTER TABLE public.personality_scores ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.personality_scores ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.personality_scores ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.personality_scores ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.personality_scores;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.personality_scores
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.profiles;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- project_publications
ALTER TABLE public.project_publications ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.project_publications ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.project_publications ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.project_publications;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.project_publications
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- projects
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.projects;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- proposed_relations
ALTER TABLE public.proposed_relations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.proposed_relations ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.proposed_relations ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.proposed_relations;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.proposed_relations
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- publications
ALTER TABLE public.publications ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.publications ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.publications ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.publications;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.publications
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- resources
ALTER TABLE public.resources ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.resources ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.resources;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.resources
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- software_tools
ALTER TABLE public.software_tools ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.software_tools ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.software_tools;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.software_tools
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- species
ALTER TABLE public.species ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.species ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.species;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.species
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- state_privacy_rules
ALTER TABLE public.state_privacy_rules ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.state_privacy_rules ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.state_privacy_rules;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.state_privacy_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- system_alerts
ALTER TABLE public.system_alerts ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.system_alerts ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.system_alerts;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.system_alerts
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- user_dashboard_layouts
ALTER TABLE public.user_dashboard_layouts ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.user_dashboard_layouts ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.user_dashboard_layouts;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.user_dashboard_layouts
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- user_roles
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.user_roles;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- working_group_dashboard_defaults
ALTER TABLE public.working_group_dashboard_defaults ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.working_group_dashboard_defaults ADD COLUMN IF NOT EXISTS updated_via text;
DROP TRIGGER IF EXISTS trg_touch_provenance ON public.working_group_dashboard_defaults;
CREATE TRIGGER trg_touch_provenance BEFORE UPDATE ON public.working_group_dashboard_defaults
  FOR EACH ROW EXECUTE FUNCTION public.touch_provenance();

-- Verify: this must return ZERO rows. Any row is a table still missing one of the four columns.
SELECT c.relname AS table_name,
       bool_or(a.attname = 'created_at')  AS created_at,
       bool_or(a.attname = 'updated_at')  AS updated_at,
       bool_or(a.attname = 'updated_by')  AS updated_by,
       bool_or(a.attname = 'updated_via') AS updated_via
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND c.relname NOT IN ('analytics_clicks', 'analytics_pageviews', 'auth_audit_log', 'curation_audit_log', 'data_audit_log', 'edit_history', 'lovable_credit_events', 'search_queries', 'security_audit_results')
 GROUP BY c.relname, c.oid
HAVING NOT (bool_or(a.attname = 'created_at') AND bool_or(a.attname = 'updated_at')
            AND bool_or(a.attname = 'updated_by') AND bool_or(a.attname = 'updated_via'))
 ORDER BY 1;
