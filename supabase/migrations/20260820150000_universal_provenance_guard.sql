-- The provenance guard covers EVERY curated table, and keeps covering new ones.
-- Constitution Principles X and XI.
--
-- WHY. 20260820120000 guarded exactly one table, with a hardcoded column list. That protects
-- projects.study_species and nothing else: the same silent overwrite that put a wrong species on a
-- cowbird project is still possible on investigators, grants, publications, species, organizations
-- and fifty other tables, and would be possible on every table added after today. A rule that has to
-- be re-applied by hand for each new table is a rule that will be missed.
--
-- DEFAULT ON, opt out by name. Coverage is now every table in `public` that has a uuid `id`, minus a
-- short exclusion list. The list is the interesting part, because each entry is a claim that
-- per-cell provenance would be noise rather than evidence:
--
--   the mechanism itself      field_provenance, source_classes -- recording provenance about
--                             provenance recurses.
--   append-only logs          data_audit_log, auth_audit_log, edit_history, curation_audit_log,
--                             analytics_*, search_queries, security_audit_results. A log row is
--                             already a historical assertion; it has no "current value" to grade.
--   derived bulk              knowledge_embeddings. Regenerated wholesale, and a vector has no
--                             human-meaningful provenance beyond the row it came from.
--   pipeline state            harvester_queue, harvester_runs, news_candidates. Rewritten every run;
--                             grading transient state says nothing about the record.
--   personal preferences      user_dashboard_layouts, working_group_dashboard_defaults. Not the
--                             scientific record.
--   billing                   lovable_invoices, lovable_user_usage, lovable_credit_events.
--   external snapshots        slack_channel_members, slack_channel_pending, slack_channels. A
--                             mirror of Slack, replaced by each survey; the truth lives in Slack.
--
-- Anything not named here is guarded, including tables that do not exist yet.
--
-- GOING FORWARD, two mechanisms because one of them may not be permitted. An event trigger catches
-- CREATE TABLE the instant it happens but needs privileges Supabase does not always grant, so it is
-- attempted inside an exception handler. provenance_attach_all() is the portable fallback, scheduled
-- on pg_cron, and is also what this migration runs once to cover the existing 50-odd tables.
-- Belt and braces: the event trigger makes it immediate, the cron makes it certain.
--
-- WHAT ENFORCEMENT WILL AND WILL NOT DO on day one. No table outside projects has any standing
-- claim yet, and the gate only fires when an UNVERIFIED write lands on a VERIFIED cell. So nothing
-- is refused today; claims accumulate as writes happen, and the lock closes behind the first human
-- to touch each cell. From then on a service-role writer that has not declared itself is G8 and
-- cannot overwrite that cell. That is the intent, and it means the enumeration below is a live
-- to-do list, not a formality:
--
--   nih-grants            writes grants/resources/organizations/investigators from RePORTER. Now
--                         declares authoritative_registry (G1), which is both true and the only
--                         thing that lets it keep refreshing a grant a human has edited.
--   suggest-related       declares algorithmic (G5). Already refused against the G4
--                         related_project_ids, deliberately.
--   onboard_member,       SECURITY DEFINER, called by a signed-in admin over RPC, so auth.uid() is
--   offboard_member       the caller and they resolve to curator_fill (G4). Equal grade, allowed.
--   group-audit,          service role, no JWT -> G8. They write investigators.working_groups and
--   sync-member-groups,   onboarding_checklist. Once a human edits one of those cells by hand, these
--   slack-survey          will be REFUSED there. That is correct, but each needs to either declare
--                         a class or handle the refusal -- suggest-related is the worked example.
--   ProjectProfile, the   browser, signed-in -> curator_fill. Unaffected.
--   admin console
--
-- KG migrations are NOT applied by db push -- run this in the KG SQL editor (vpexxhfpvghlejljwpvt).

SELECT public.set_actor('migration:20260820150000');

-- ── 1. Scope ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provenance_excluded_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    'field_provenance', 'source_classes',
    'data_audit_log', 'auth_audit_log', 'edit_history', 'curation_audit_log',
    'analytics_clicks', 'analytics_pageviews', 'search_queries', 'security_audit_results',
    'knowledge_embeddings',
    'harvester_queue', 'harvester_runs', 'news_candidates',
    'user_dashboard_layouts', 'working_group_dashboard_defaults',
    'lovable_invoices', 'lovable_user_usage', 'lovable_credit_events',
    'slack_channel_members', 'slack_channel_pending', 'slack_channels'
  ]::text[]
$fn$;

COMMENT ON FUNCTION public.provenance_excluded_tables() IS
  'Tables the provenance guard skips: the mechanism itself, append-only logs, regenerated bulk, transient pipeline state, personal preferences, billing, and mirrors of external systems. Everything else in public with a uuid id is guarded, including tables created later.';

/** Columns that are bookkeeping rather than content. Grading these would bury the cells that
 *  matter under rows nobody reads: an updated_at changes on every write by definition. */
CREATE OR REPLACE FUNCTION public.provenance_excluded_columns()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY[
    'id', 'created_at', 'updated_at',
    'last_edited_by', 'edited_by', 'updated_by', 'created_by',
    'search_vector', 'embedding', 'tsv'
  ]::text[]
$fn$;

GRANT EXECUTE ON FUNCTION public.provenance_excluded_tables() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.provenance_excluded_columns() TO authenticated, service_role;

/** Which tables are in scope right now. A uuid `id` is required because field_provenance.entity_id
 *  is uuid -- a table keyed on bigint or a composite cannot be addressed by this store, and
 *  silently skipping it is better than a cast that half-works. */
CREATE OR REPLACE VIEW public.provenance_guardable_tables AS
SELECT c.relname AS table_name,
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = c.oid
                  AND t.tgname = 'trg_enforce_field_provenance'
                  AND NOT t.tgisinternal) AS is_guarded
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'
   AND NOT (c.relname = ANY (public.provenance_excluded_tables()))
   AND EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'id'
        AND a.atttypid = 'uuid'::regtype AND a.attnum > 0 AND NOT a.attisdropped);

COMMENT ON VIEW public.provenance_guardable_tables IS
  'Every table the provenance guard should be attached to, and whether it currently is. is_guarded false anywhere means coverage has drifted -- see provenance_attach_all().';

GRANT SELECT ON public.provenance_guardable_tables TO authenticated;

-- ── 2. The guard, generalised off `projects` ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_field_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _class     text := public.current_source_class();
  _verified  boolean;
  _actor     text := public.current_actor_via();
  _tbl       text := TG_TABLE_NAME;
  _oldj      jsonb := to_jsonb(OLD);
  _newj      jsonb := to_jsonb(NEW);
  _id        uuid;
  _skip      text[] := public.provenance_excluded_columns();
  _col       text;
  _oldv      jsonb;
  _newv      jsonb;
  _txt       text;
  _cur_ok    boolean;
  _cur_label text;
  _cur_agent text;
  _cur_who   text;
  _key       text;
BEGIN
  _id := nullif(_newj ->> 'id', '')::uuid;
  IF _id IS NULL THEN
    RETURN NEW;   -- nothing addressable; the eligibility view should have prevented this
  END IF;

  SELECT sc.is_verified INTO _verified
    FROM public.source_classes sc WHERE sc.code = _class;

  -- Every column of the row, discovered from the row itself. No per-table column list to maintain,
  -- which is the whole point: a column added next year is covered the moment it holds a value.
  FOR _col IN SELECT k FROM jsonb_object_keys(_newj) AS k LOOP
    CONTINUE WHEN _col = ANY (_skip);

    _oldv := _oldj -> _col;
    _newv := _newj -> _col;
    CONTINUE WHEN _oldv IS NOT DISTINCT FROM _newv;

    -- A jsonb column is not one value, it is many. metadata on projects holds up to 72 separately
    -- sourced answers, so each KEY is graded on its own; one verdict for the blob says nothing.
    IF jsonb_typeof(_newv) = 'object' THEN
      FOR _key IN SELECT k FROM jsonb_object_keys(_newv) AS k LOOP
        CONTINUE WHEN _key = 'field_provenance';
        CONTINUE WHEN (_oldv -> _key) IS NOT DISTINCT FROM (_newv -> _key);
        _txt := CASE WHEN jsonb_typeof(_newv -> _key) = 'string'
                     THEN _newv ->> _key ELSE (_newv -> _key)::text END;
        CONTINUE WHEN btrim(coalesce(_txt, '')) = '';

        SELECT sc.is_verified, sc.label, fp.agent_label
          INTO _cur_ok, _cur_label, _cur_agent
          FROM public.field_provenance fp
          JOIN public.source_classes sc ON sc.code = fp.source_class
         WHERE fp.entity_table = _tbl AND fp.entity_id = _id
           AND fp.entity_column = _col || '.' || _key
         ORDER BY fp.recorded_at DESC, fp.id DESC LIMIT 1;

        _cur_who := CASE WHEN _cur_agent IS NULL OR btrim(_cur_agent) = ''
                              OR _cur_agent = _cur_label THEN ''
                         ELSE ' (' || _cur_agent || ')' END;

        IF _cur_ok AND NOT _verified THEN
          RAISE EXCEPTION
            'Refusing to overwrite %.%.% : it is held at "%"%, and this write is only "%".',
            _tbl, _col, _key, _cur_label, _cur_who, _class
            USING ERRCODE = 'check_violation',
                  HINT = 'Constitution XI: a machine may not silently overwrite a human- or registry-established value. Declare a better source with set_source_class() or the x-bbqs-source-class header.';
        END IF;

        INSERT INTO public.field_provenance (
          entity_table, entity_id, entity_column, source_class, activity,
          agent_id, agent_label, value_text, recorded_by)
        VALUES (_tbl, _id, _col || '.' || _key, _class, 'direct_write',
                auth.uid(), _actor, left(_txt, 500), _actor);
      END LOOP;
      CONTINUE;
    END IF;

    -- Scalar or array column. Arrays are joined the way the backfill migrations wrote them, so
    -- value_text has one shape and "does this cell still hold what the claim describes" works.
    _txt := CASE
      WHEN jsonb_typeof(_newv) = 'array'
        THEN (SELECT string_agg(e, ', ') FROM jsonb_array_elements_text(_newv) AS e)
      ELSE _newj ->> _col
    END;
    CONTINUE WHEN btrim(coalesce(_txt, '')) = '';

    SELECT sc.is_verified, sc.label, fp.agent_label
      INTO _cur_ok, _cur_label, _cur_agent
      FROM public.field_provenance fp
      JOIN public.source_classes sc ON sc.code = fp.source_class
     WHERE fp.entity_table = _tbl AND fp.entity_id = _id AND fp.entity_column = _col
     ORDER BY fp.recorded_at DESC, fp.id DESC LIMIT 1;

    _cur_who := CASE WHEN _cur_agent IS NULL OR btrim(_cur_agent) = ''
                          OR _cur_agent = _cur_label THEN ''
                     ELSE ' (' || _cur_agent || ')' END;

    IF _cur_ok AND NOT _verified THEN
      RAISE EXCEPTION
        'Refusing to overwrite %.% : it is held at "%"%, and this write is only "%".',
        _tbl, _col, _cur_label, _cur_who, _class
        USING ERRCODE = 'check_violation',
              HINT = 'Constitution XI: a machine may not silently overwrite a human- or registry-established value. Declare a better source with set_source_class() or the x-bbqs-source-class header.';
    END IF;

    INSERT INTO public.field_provenance (
      entity_table, entity_id, entity_column, source_class, activity,
      agent_id, agent_label, value_text, recorded_by)
    VALUES (_tbl, _id, _col, _class, 'direct_write',
            auth.uid(), _actor, left(_txt, 500), _actor);
  END LOOP;

  RETURN NEW;
END;
$fn$;

-- Superseded. The guard discovers columns from the row now, so a hand-kept per-table list is not
-- just unused but actively misleading: someone reading it would think editing it changes coverage.
COMMENT ON FUNCTION public.provenance_tracked_columns() IS
  'SUPERSEDED by migration 20260820150000 and read by nothing. The guard now derives tracked columns from the row itself, minus provenance_excluded_columns(). Editing this list changes nothing.';

COMMENT ON FUNCTION public.enforce_field_provenance() IS
  'Table-agnostic provenance guard. Refuses an unverified write onto a cell held by a verified source, and records a claim for every changed cell -- per key for jsonb columns. Columns are discovered from the row, so a new column is covered as soon as it holds a value.';

-- ── 3. Attach, now and to whatever comes later ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provenance_attach_guard(_table text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.provenance_guardable_tables
                  WHERE table_name = _table AND NOT is_guarded) THEN
    RETURN false;
  END IF;
  EXECUTE format(
    'CREATE TRIGGER trg_enforce_field_provenance BEFORE UPDATE ON public.%I '
    'FOR EACH ROW EXECUTE FUNCTION public.enforce_field_provenance()', _table);
  RAISE NOTICE 'provenance guard attached to %', _table;
  RETURN true;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.provenance_attach_all()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _t text;
  _n int := 0;
BEGIN
  FOR _t IN SELECT table_name FROM public.provenance_guardable_tables WHERE NOT is_guarded LOOP
    IF public.provenance_attach_guard(_t) THEN _n := _n + 1; END IF;
  END LOOP;
  RETURN _n;
END;
$fn$;

COMMENT ON FUNCTION public.provenance_attach_all() IS
  'Attaches the provenance guard to every guardable table that lacks it, and returns how many it added. Idempotent. Run by migration 20260820150000, by the ddl event trigger where privileges allow, and nightly by pg_cron so a table created by any route is covered within a day.';

GRANT EXECUTE ON FUNCTION public.provenance_attach_all() TO service_role;

SELECT public.provenance_attach_all() AS tables_newly_guarded;

-- Immediate coverage for new tables, IF the role may create event triggers. Supabase does not
-- always grant that, and a migration that dies on a privilege error would take the whole guard with
-- it -- so the attempt is contained and its failure is reported, not fatal.
CREATE OR REPLACE FUNCTION public.provenance_guard_new_tables()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _obj record;
BEGIN
  FOR _obj IN SELECT * FROM pg_event_trigger_ddl_commands()
               WHERE command_tag IN ('CREATE TABLE', 'ALTER TABLE') LOOP
    IF _obj.schema_name = 'public' THEN
      PERFORM public.provenance_attach_guard(split_part(_obj.object_identity, '.', 2));
    END IF;
  END LOOP;
END;
$fn$;

DO $do$
BEGIN
  DROP EVENT TRIGGER IF EXISTS trg_provenance_guard_new_tables;
  CREATE EVENT TRIGGER trg_provenance_guard_new_tables
    ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE', 'ALTER TABLE')
    EXECUTE FUNCTION public.provenance_guard_new_tables();
  RAISE NOTICE 'event trigger installed: new tables are guarded immediately';
EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
  RAISE NOTICE 'event trigger NOT installed (%). The pg_cron job below is the fallback; new tables are guarded within a day rather than instantly.', SQLERRM;
END
$do$;

-- The portable half. Runs nightly; catches anything the event trigger could not.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'provenance-attach-all') THEN
      PERFORM cron.unschedule('provenance-attach-all');
    END IF;
    PERFORM cron.schedule('provenance-attach-all', '17 4 * * *',
                          $job$SELECT public.provenance_attach_all();$job$);
    RAISE NOTICE 'pg_cron job scheduled: provenance-attach-all, nightly 04:17';
  ELSE
    RAISE NOTICE 'pg_cron not installed; run provenance_attach_all() after any migration that adds a table';
  END IF;
END
$do$;

-- ── Verify ────────────────────────────────────────────────────────────────────────────────────
-- 1) Coverage. unguarded MUST be 0.
SELECT count(*) FILTER (WHERE is_guarded)     AS guarded,
       count(*) FILTER (WHERE NOT is_guarded) AS unguarded_must_be_0
  FROM public.provenance_guardable_tables;

-- 2) What is covered, and what was deliberately left out.
SELECT table_name FROM public.provenance_guardable_tables ORDER BY table_name;
SELECT unnest(public.provenance_excluded_tables()) AS excluded_by_design ORDER BY 1;

-- 3) Tables skipped because they have no uuid id -- these are invisible to the guard, so it is worth
--    knowing which they are rather than assuming the list above is everything.
SELECT c.relname AS no_uuid_id_so_unguardable
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND NOT (c.relname = ANY (public.provenance_excluded_tables()))
   AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'id'
                      AND a.atttypid = 'uuid'::regtype AND a.attnum > 0 AND NOT a.attisdropped)
 ORDER BY 1;

-- 4) Is the immediate mechanism in place, or are we on the nightly one?
SELECT count(*) AS event_trigger_installed
  FROM pg_event_trigger WHERE evtname = 'trg_provenance_guard_new_tables';
