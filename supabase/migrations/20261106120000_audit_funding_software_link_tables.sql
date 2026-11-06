-- Principle X: funding_opportunity_orgs (20261103130000) and project_software_tools (20261103140000)
-- were created without an audit trigger, so their link rows never reached data_audit_log. Attach the
-- same trigger every other audited table uses (20260810160000), and give both a uuid id + timestamps so
-- the provenance guard can cover them. Guarded with to_regclass: safe to run whether or not each table
-- exists yet, and safe to run twice. Rows inserted before this ran have no audit history; that is
-- recorded here rather than back-filled with invented entries.
SELECT public.set_actor('migration:audit_funding_software_link_tables');

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['funding_opportunity_orgs', 'project_software_tools'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '% does not exist; skipped', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid()', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (id)', t || '_id_key', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%s ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_audit_%s AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.log_data_change()', t, t);
  END LOOP;
END
$do$;

-- Attach the provenance guard now that both tables carry a uuid id (it also runs nightly via pg_cron).
SELECT public.provenance_attach_all();

-- Verify: expect one row per existing table, each with its trg_audit_ trigger.
SELECT c.relname AS table_name, t.tgname AS audit_trigger
FROM pg_class c LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname LIKE 'trg_audit_%'
WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('funding_opportunity_orgs', 'project_software_tools');
