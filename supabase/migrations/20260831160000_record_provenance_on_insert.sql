-- Record provenance when a row is CREATED, not only when a value changes.
--
-- trg_enforce_field_provenance is BEFORE UPDATE. It was written to stop a machine overwriting a
-- curated value, and on INSERT there is nothing to overwrite — so recording, which was only ever a
-- side effect of guarding, never happened for new rows. Every cell of a new grant, person, project
-- or roster row therefore starts with no claim, and the first claim about a value — where it came
-- from when it arrived — is the one the store never held. R61MH142354 showed no chips for this
-- reason; 20260831150000 wrote its 24 claims by hand.
--
-- ONLY WHEN THE WRITER DECLARED ITSELF. current_source_class() always answers, falling back to
-- curator_fill for a signed-in user and 'unknown' (G7) otherwise. Recording every INSERT through
-- that fallback would stamp G7 on every cell of every bulk seed, and provenance_worklist is defined
-- as the cells no one stands behind — it would go from a queue someone can work to tens of
-- thousands of rows no one can. So this records only an EXPLICIT declaration: set_source_class(),
-- or the x-bbqs-source-class header. An undeclared insert records nothing, exactly as today.
--
-- Which makes this inert for 26 of the 29 service-role functions that write. Only nih-grants and
-- reporter-pi-sync (authoritative_registry) and suggest-related (algorithmic) declare today.
-- Measured cost where it does apply: the nih-grants seed writes ~13 rows per grant across
-- grants/resources/organizations/investigators/investigator_organizations/projects, its projects
-- INSERT sets grant_number and grant_id only (no metadata, so no 72-key fan-out), and everything
-- else is upsert-with-existence-check — on re-run those are UPDATEs, already covered. Low thousands
-- of G1 claims once, near zero after.
--
-- Adding a declaration to any other function is a SEPARATE decision, not a follow-up chore: it also
-- raises what that path may overwrite. import-grant-publications writes at G7 today and cannot
-- touch a verified cell; declaring it authoritative_registry would let it.
--
-- Apply MANUALLY in the KG SQL editor.

SELECT public.set_actor('migration:20260831_record_provenance_on_insert');

-- ── 1. Was a class actually declared, or is this the fallback? ──────────────
CREATE OR REPLACE FUNCTION public.source_class_was_declared()
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.source_classes sc
     WHERE sc.code = coalesce(
       nullif(current_setting('app.source_class', true), ''),
       nullif(current_setting('request.headers', true)::jsonb ->> 'x-bbqs-source-class', '')
     )
  )
$fn$;

COMMENT ON FUNCTION public.source_class_was_declared() IS
  'True only when the current write NAMED its source class — set_source_class() or the x-bbqs-source-class header — and that name is a real source class. Deliberately narrower than current_source_class(), which always answers: the difference between "RePORTER says so" and "nobody said".';

GRANT EXECUTE ON FUNCTION public.source_class_was_declared() TO authenticated, service_role;

-- ── 2. The recorder ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_field_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _class text := public.current_source_class();
  _actor text := public.current_actor_via();
  _newj  jsonb := to_jsonb(NEW);
  _skip  text[] := public.provenance_excluded_columns();
  _id    uuid;
  _col   text;
  _val   jsonb;
  _key   text;
  _txt   text;
BEGIN
  IF NOT public.source_class_was_declared() THEN
    RETURN NULL;
  END IF;

  _id := nullif(_newj ->> 'id', '')::uuid;
  IF _id IS NULL THEN
    RETURN NULL;
  END IF;

  FOR _col IN SELECT k FROM jsonb_object_keys(_newj) AS k LOOP
    CONTINUE WHEN _col = ANY (_skip);
    _val := _newj -> _col;
    CONTINUE WHEN _val IS NULL OR jsonb_typeof(_val) = 'null';

    -- A jsonb column is many values, graded per key — same rule the UPDATE guard uses.
    IF jsonb_typeof(_val) = 'object' THEN
      FOR _key IN SELECT k FROM jsonb_object_keys(_val) AS k LOOP
        CONTINUE WHEN _key = 'field_provenance';
        _txt := CASE WHEN jsonb_typeof(_val -> _key) = 'string'
                     THEN _val ->> _key ELSE (_val -> _key)::text END;
        CONTINUE WHEN btrim(coalesce(_txt, '')) = '';

        INSERT INTO public.field_provenance (
          entity_table, entity_id, entity_column, source_class, activity,
          agent_label, value_text, recorded_by)
        VALUES (TG_TABLE_NAME, _id, _col || '.' || _key, _class, 'record_created',
                _actor, left(_txt, 4000), _actor);
      END LOOP;
      CONTINUE;
    END IF;

    _txt := CASE WHEN jsonb_typeof(_val) = 'string' THEN _val #>> '{}' ELSE _val::text END;
    CONTINUE WHEN btrim(coalesce(_txt, '')) = '';

    INSERT INTO public.field_provenance (
      entity_table, entity_id, entity_column, source_class, activity,
      agent_label, value_text, recorded_by)
    VALUES (TG_TABLE_NAME, _id, _col, _class, 'record_created',
            _actor, left(_txt, 4000), _actor);
  END LOOP;

  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION public.record_field_provenance() IS
  'Records one claim per non-empty cell of a NEWLY INSERTED row, but only when the writer declared a source class. Pure recording: there is no standing claim on a new id, so nothing to refuse — the enforcement half lives in enforce_field_provenance() on UPDATE. AFTER INSERT, returns NULL.';

-- ── 3. Attach it wherever the guard goes ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.provenance_attach_recorder(_table text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.provenance_guardable_tables
                  WHERE table_name = _table AND NOT is_recorded) THEN
    RETURN false;
  END IF;
  EXECUTE format(
    'CREATE TRIGGER trg_record_field_provenance AFTER INSERT ON public.%I '
    'FOR EACH ROW EXECUTE FUNCTION public.record_field_provenance()', _table);
  RAISE NOTICE 'provenance recorder attached to %', _table;
  RETURN true;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.provenance_attach_recorder(text) TO service_role;

-- CREATE OR REPLACE VIEW can APPEND a column but never drop or reorder one (42P16), so is_recorded
-- goes last.
CREATE OR REPLACE VIEW public.provenance_guardable_tables AS
SELECT c.relname AS table_name,
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = c.oid
                  AND t.tgname = 'trg_enforce_field_provenance'
                  AND NOT t.tgisinternal) AS is_guarded,
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = c.oid
                  AND t.tgname = 'trg_record_field_provenance'
                  AND NOT t.tgisinternal) AS is_recorded
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
  'Every table provenance should cover, and whether each half is attached: is_guarded (BEFORE UPDATE, refuses a machine over a human) and is_recorded (AFTER INSERT, records how a value arrived). Either false anywhere means coverage has drifted — see provenance_attach_all().';

CREATE OR REPLACE FUNCTION public.provenance_attach_all()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _t text;
  _n int := 0;
BEGIN
  FOR _t IN SELECT table_name FROM public.provenance_guardable_tables WHERE NOT is_guarded LOOP
    IF public.provenance_attach_guard(_t) THEN _n := _n + 1; END IF;
  END LOOP;
  FOR _t IN SELECT table_name FROM public.provenance_guardable_tables WHERE NOT is_recorded LOOP
    IF public.provenance_attach_recorder(_t) THEN _n := _n + 1; END IF;
  END LOOP;
  RETURN _n;
END;
$fn$;

COMMENT ON FUNCTION public.provenance_attach_all() IS
  'Attaches BOTH provenance triggers to every guardable table missing either, and returns how many it added. Idempotent. Run by migrations 20260820150000 and 20260831160000, by the ddl event trigger where privileges allow, and nightly by pg_cron so a table created by any route is covered within a day.';

CREATE OR REPLACE FUNCTION public.provenance_guard_new_tables()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _obj record;
  _tbl text;
BEGIN
  FOR _obj IN SELECT * FROM pg_event_trigger_ddl_commands()
               WHERE command_tag IN ('CREATE TABLE', 'ALTER TABLE') LOOP
    IF _obj.schema_name = 'public' THEN
      _tbl := split_part(_obj.object_identity, '.', 2);
      PERFORM public.provenance_attach_guard(_tbl);
      PERFORM public.provenance_attach_recorder(_tbl);
    END IF;
  END LOOP;
END;
$fn$;

SELECT public.provenance_attach_all() AS triggers_newly_attached;

-- ── 4. Verify ──────────────────────────────────────────────────────────────
-- Expect zero rows: every guardable table carries both halves.
SELECT table_name, is_guarded, is_recorded
  FROM public.provenance_guardable_tables
 WHERE NOT is_guarded OR NOT is_recorded
 ORDER BY table_name;

-- Prove it both ways on a real table, leaving nothing behind. The probe rows CANNOT simply be
-- deleted afterwards: field_provenance is append-only (BEFORE UPDATE OR DELETE), so removing the
-- organizations would strand their claims forever. So the whole probe runs in a subtransaction and
-- is rolled back by a sentinel exception — which reverts the orgs and the claims together.
-- PL/pgSQL variables are memory, not transactional, so the counts survive the rollback.
DO $do$
DECLARE _id uuid; _declared int := -1; _undeclared int := -1;
BEGIN
  BEGIN
    PERFORM set_config('app.source_class', '', true);
    INSERT INTO public.organizations (name) VALUES ('ZZZ provenance probe (undeclared)')
      RETURNING id INTO _id;
    SELECT count(*) INTO _undeclared FROM public.field_provenance
     WHERE entity_table = 'organizations' AND entity_id = _id;

    PERFORM public.set_source_class('curator_fill');
    INSERT INTO public.organizations (name) VALUES ('ZZZ provenance probe (declared)')
      RETURNING id INTO _id;
    SELECT count(*) INTO _declared FROM public.field_provenance
     WHERE entity_table = 'organizations' AND entity_id = _id;

    RAISE EXCEPTION USING ERRCODE = 'PV001', MESSAGE = 'probe rollback';
  EXCEPTION WHEN SQLSTATE 'PV001' THEN
    NULL;
  END;

  PERFORM set_config('app.source_class', '', true);

  RAISE NOTICE 'undeclared insert recorded % claim(s) (expect 0); declared recorded % (expect >0)',
    _undeclared, _declared;
  IF _undeclared <> 0 OR _declared < 1 THEN
    RAISE EXCEPTION 'recorder is not behaving: undeclared=%, declared=%', _undeclared, _declared;
  END IF;
END
$do$;
