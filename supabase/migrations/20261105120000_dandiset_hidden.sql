-- Hidden dandisets (#506). A hidden dandiset stays in the mirror but has no resources row, so it is
-- off the Resources page, search, the KG and the MCP. ember-dandiset-sync will not recreate it.
-- Apply by hand in the SQL editor for vpexxhfpvghlejljwpvt.

SELECT public.set_actor('migration:20261105120000_dandiset_hidden');

ALTER TABLE public.dandisets
  ADD COLUMN IF NOT EXISTS hidden        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_reason text,
  ADD COLUMN IF NOT EXISTS hidden_by     uuid,
  ADD COLUMN IF NOT EXISTS hidden_at     timestamptz;

ALTER TABLE public.dandisets DROP CONSTRAINT IF EXISTS dandisets_hidden_has_reason;
ALTER TABLE public.dandisets
  ADD CONSTRAINT dandisets_hidden_has_reason CHECK (NOT hidden OR hidden_reason IS NOT NULL);

-- dandisets is not audited (the nightly sync rewrites every row), so hidden_by/hidden_at carry who
-- decided. The resources delete below is audited.
CREATE OR REPLACE FUNCTION public.set_dandiset_hidden(
  _dandiset_ids text[], _hidden boolean DEFAULT true, _reason text DEFAULT NULL, _instance text DEFAULT 'ember')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  _d       public.dandisets;
  _rid     uuid;
  _missing text[];
  _out     jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_curator_or_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins or curators can hide or unhide dandisets';
  END IF;
  IF coalesce(cardinality(_dandiset_ids), 0) = 0 THEN
    RAISE EXCEPTION 'No dandiset ids given';
  END IF;
  IF _hidden AND nullif(btrim(_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required to hide a dandiset';
  END IF;

  SELECT array_agg(x ORDER BY x) INTO _missing FROM unnest(_dandiset_ids) x
   WHERE NOT EXISTS (SELECT 1 FROM public.dandisets d WHERE d.instance = _instance AND d.dandiset_id = x);
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'Not in the % mirror: %', _instance, array_to_string(_missing, ', ');
  END IF;

  FOR _d IN SELECT * FROM public.dandisets
             WHERE instance = _instance AND dandiset_id = ANY (_dandiset_ids)
             ORDER BY dandiset_id FOR UPDATE LOOP
    IF _hidden THEN
      UPDATE public.dandisets
         SET hidden = true, hidden_reason = btrim(_reason), hidden_by = auth.uid(), hidden_at = now(),
             resource_id = NULL
       WHERE id = _d.id;
      IF _d.resource_id IS NOT NULL THEN
        DELETE FROM public.resources WHERE id = _d.resource_id;
      END IF;
      _out := _out || jsonb_build_object('dandiset_id', _d.dandiset_id, 'name', _d.name,
                                         'hidden', true, 'resource_removed', _d.resource_id IS NOT NULL);
    ELSE
      _rid := _d.resource_id;
      IF _rid IS NULL THEN
        -- Same row ember-dandiset-sync would have created.
        INSERT INTO public.resources (name, description, resource_type, external_url, metadata)
        VALUES (_d.name, left(coalesce(_d.description, ''), 4000), 'dataset',
                coalesce(_d.draft_url, 'https://dandi.emberarchive.org/dandiset/' || _d.dandiset_id),
                jsonb_build_object('source', _d.instance, 'dandiset_id', _d.dandiset_id))
        RETURNING id INTO _rid;
      END IF;
      UPDATE public.dandisets
         SET hidden = false, hidden_reason = NULL, hidden_by = NULL, hidden_at = NULL, resource_id = _rid
       WHERE id = _d.id;
      _out := _out || jsonb_build_object('dandiset_id', _d.dandiset_id, 'name', _d.name,
                                         'hidden', false, 'resource_id', _rid);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'count', jsonb_array_length(_out), 'dandisets', _out);
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_dandiset_hidden(text[], boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_dandiset_hidden(text[], boolean, text, text) TO authenticated;

-- ── Check (read-only) ────────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'dandisets' AND column_name LIKE 'hidden%'
 ORDER BY column_name;
