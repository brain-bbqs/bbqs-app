-- Records what was applied in the SQL editor on 2026-11-03 (#444), as read back from production on
-- 2026-11-05. Already live there: idempotent, nothing to apply.

SELECT public.set_actor('migration:20261103153000_publication_fulltext');

CREATE TABLE IF NOT EXISTS public.publication_fulltext (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL UNIQUE REFERENCES public.publications(id) ON DELETE CASCADE,
  text_source    text NOT NULL,
  text_sha256    text NOT NULL,
  char_count     integer NOT NULL,
  license        text,
  retrieved_at   timestamptz,
  figure_count   integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Kept out of publication_fulltext so log_data_change doesn't copy the whole text into every audit row.
CREATE TABLE IF NOT EXISTS public.publication_fulltext_body (
  fulltext_id uuid PRIMARY KEY REFERENCES public.publication_fulltext(id) ON DELETE CASCADE,
  body        text NOT NULL,
  structure   jsonb
);

CREATE TABLE IF NOT EXISTS public.publication_figure (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES public.publications(id) ON DELETE CASCADE,
  fig_label      text,
  caption        text,
  storage_path   text NOT NULL,
  content_type   text,
  byte_size      integer,
  sha256         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publication_id, storage_path)
);
CREATE INDEX IF NOT EXISTS publication_figure_publication_idx ON public.publication_figure (publication_id);

CREATE OR REPLACE FUNCTION public.check_publication_fulltext_sha()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE want text;
BEGIN
  SELECT text_sha256 INTO want FROM public.publication_fulltext WHERE id = NEW.fulltext_id;
  IF want IS NULL THEN
    RAISE EXCEPTION 'publication_fulltext % does not exist', NEW.fulltext_id;
  END IF;
  IF encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex') <> want THEN
    RAISE EXCEPTION 'body does not match text_sha256 on publication_fulltext %', NEW.fulltext_id;
  END IF;
  RETURN NEW;
END
$function$;

ALTER TABLE public.publication_fulltext      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publication_fulltext_body ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publication_figure        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage publication_fulltext" ON public.publication_fulltext;
CREATE POLICY "Admins manage publication_fulltext" ON public.publication_fulltext FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins manage publication_fulltext_body" ON public.publication_fulltext_body;
CREATE POLICY "Admins manage publication_fulltext_body" ON public.publication_fulltext_body FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins manage publication_figure" ON public.publication_figure;
CREATE POLICY "Admins manage publication_figure" ON public.publication_figure FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

DROP TRIGGER IF EXISTS trg_audit_publication_fulltext ON public.publication_fulltext;
CREATE TRIGGER trg_audit_publication_fulltext AFTER INSERT OR DELETE OR UPDATE ON public.publication_fulltext
  FOR EACH ROW EXECUTE FUNCTION public.log_data_change();
DROP TRIGGER IF EXISTS trg_enforce_field_provenance ON public.publication_fulltext;
CREATE TRIGGER trg_enforce_field_provenance BEFORE UPDATE ON public.publication_fulltext
  FOR EACH ROW EXECUTE FUNCTION public.enforce_field_provenance();
DROP TRIGGER IF EXISTS trg_record_field_provenance ON public.publication_fulltext;
CREATE TRIGGER trg_record_field_provenance AFTER INSERT ON public.publication_fulltext
  FOR EACH ROW EXECUTE FUNCTION public.record_field_provenance();
DROP TRIGGER IF EXISTS update_publication_fulltext_updated_at ON public.publication_fulltext;
CREATE TRIGGER update_publication_fulltext_updated_at BEFORE UPDATE ON public.publication_fulltext
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_check_publication_fulltext_sha ON public.publication_fulltext_body;
CREATE TRIGGER trg_check_publication_fulltext_sha BEFORE INSERT OR UPDATE ON public.publication_fulltext_body
  FOR EACH ROW EXECUTE FUNCTION public.check_publication_fulltext_sha();

DROP TRIGGER IF EXISTS trg_audit_publication_figure ON public.publication_figure;
CREATE TRIGGER trg_audit_publication_figure AFTER INSERT OR DELETE OR UPDATE ON public.publication_figure
  FOR EACH ROW EXECUTE FUNCTION public.log_data_change();
DROP TRIGGER IF EXISTS trg_enforce_field_provenance ON public.publication_figure;
CREATE TRIGGER trg_enforce_field_provenance BEFORE UPDATE ON public.publication_figure
  FOR EACH ROW EXECUTE FUNCTION public.enforce_field_provenance();
DROP TRIGGER IF EXISTS trg_record_field_provenance ON public.publication_figure;
CREATE TRIGGER trg_record_field_provenance AFTER INSERT ON public.publication_figure
  FOR EACH ROW EXECUTE FUNCTION public.record_field_provenance();
DROP TRIGGER IF EXISTS update_publication_figure_updated_at ON public.publication_figure;
CREATE TRIGGER update_publication_figure_updated_at BEFORE UPDATE ON public.publication_figure
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO storage.buckets (id, name, public)
VALUES ('publication-figures', 'publication-figures', false)
ON CONFLICT (id) DO NOTHING;
