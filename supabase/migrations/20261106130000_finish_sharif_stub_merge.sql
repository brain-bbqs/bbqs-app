-- #432 / #493, applied in the SQL editor on 2026-11-06 by Sulstice. 20261103120000_merge_sharif_stub_investigator
-- never took effect: it looked the stub up by name ('Suliman Sharif (<email>)'), but the stub had been renamed
-- 'Suliman Sharif (alt)' on 11-03, so it matched nothing and returned with only a NOTICE. Its resources spine row
-- (bef104b2-...) kept the email in its name, which put the address in the public KG export.
--
-- This finishes the merge, matching the stub by id + email, and removes the two copies of the address the earlier
-- migration did not know about: the stub's spine row and the chat search index (knowledge_embeddings, which
-- embed-knowledge only ever upserts). It stops with an error on any unexpected state rather than skipping.
-- Idempotent: once the stub is gone it does nothing. The stub's address is matched by its md5 here rather than
-- written out, so this public file does not repeat it (the run used the literal; the check is identical). The stub's auth.users login is removed by hand in the dashboard.
--
-- Verified after the run: the final SELECT returned 0 rows. Note the address remains in the git history of
-- kg/export/bbqs.ttl (committed 2026-11-04 in #503); the next export refresh removes it from the current file.
SELECT public.set_actor('migration:finish_sharif_stub_merge');
SELECT public.set_source_class('curator_fill');

-- 1. Merge the stub into the MIT record. Matched by id + email: the stub was renamed
--    'Suliman Sharif (alt)' on 11-03 (see header).
DO $$
DECLARE
  _keep  constant uuid := '0ebb5b1a-b96b-41f6-a1b8-54b6e818b231';
  _stub  constant uuid := '7d177d37-27a6-4b10-8763-74ab20844adf';
  _stub_email text; _stub_res uuid; _n int;
BEGIN
  PERFORM public.set_actor('migration:finish_sharif_stub_merge');
  PERFORM public.set_source_class('curator_fill');
  IF NOT EXISTS (SELECT 1 FROM public.investigators WHERE id = _stub) THEN
    RAISE NOTICE 'stub already gone'; RETURN;
  END IF;
  SELECT email, resource_id INTO _stub_email, _stub_res
    FROM public.investigators WHERE id = _stub AND md5(lower(email)) = 'b4210b54d3163825868951a3288a4446';
  IF NOT FOUND THEN RAISE EXCEPTION 'stub % exists but its email is not the expected one; stopping', _stub; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.investigators WHERE id = _keep AND lower(email) = 'sulstice@mit.edu') THEN
    RAISE EXCEPTION 'surviving record % is not sulstice@mit.edu; stopping', _keep;
  END IF;
  SELECT count(*) INTO _n FROM public.grant_investigators WHERE investigator_id = _stub;
  IF _n > 0 THEN RAISE EXCEPTION 'stub still holds % grant link(s); stopping', _n; END IF;
  IF _stub_res IS DISTINCT FROM 'bef104b2-a9a9-41d3-a585-6575449c2966'::uuid THEN
    RAISE EXCEPTION 'stub spine row is %, not the expected bef104b2-...; stopping', _stub_res;
  END IF;

  UPDATE public.investigators
     SET secondary_emails = (SELECT array_agg(DISTINCT e) FROM unnest(COALESCE(secondary_emails, '{}') || _stub_email) AS e),
         updated_at = now()
   WHERE id = _keep;
  UPDATE public.curation_audit_log SET investigator_id = _keep WHERE investigator_id = _stub;
  DELETE FROM public.investigator_organizations WHERE investigator_id = _stub;
  DELETE FROM public.investigators WHERE id = _stub;
END $$;

-- 2. The chat assistant's search index keeps its own copy of the spine row's name (embed-knowledge
--    only upserts, never deletes), so remove those entries. This runs before the
--    spine-row delete because an index entry may reference the spine row.
DELETE FROM public.knowledge_embeddings
 WHERE source_id IN ('7d177d37-27a6-4b10-8763-74ab20844adf', 'bef104b2-a9a9-41d3-a585-6575449c2966')
    OR title ILIKE '%standardseedcorp%' OR content ILIKE '%standardseedcorp%';

-- 3. Delete the stub's spine row (its name still holds the email), only if nothing references it.
DO $$
DECLARE
  _rid constant uuid := 'bef104b2-a9a9-41d3-a585-6575449c2966';
  c record; _n int; _refs text := '';
BEGIN
  PERFORM public.set_actor('migration:finish_sharif_stub_merge');
  PERFORM public.set_source_class('curator_fill');
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = _rid) THEN RETURN; END IF;
  FOR c IN SELECT conrelid::regclass AS tbl, a.attname AS col
             FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
            WHERE k.contype = 'f' AND k.confrelid = 'public.resources'::regclass LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', c.tbl, c.col) INTO _n USING _rid;
    IF _n > 0 THEN _refs := _refs || format('%s.%s=%s ', c.tbl, c.col, _n); END IF;
  END LOOP;
  IF _refs <> '' THEN RAISE EXCEPTION 'spine row still referenced (%); stopping', _refs; END IF;
  DELETE FROM public.resources WHERE id = _rid;
END $$;

-- Verify: expect 0 rows.
SELECT 'stub still present' AS what, id::text, name FROM public.investigators WHERE id = '7d177d37-27a6-4b10-8763-74ab20844adf'
UNION ALL SELECT 'investigator name with email', id::text, name FROM public.investigators WHERE name ~ '[^ ]+@[^ ]+'
UNION ALL SELECT 'resource name with email', id::text, name FROM public.resources WHERE name ~ '[^ ]+@[^ ]+'
UNION ALL SELECT 'search index entry', id::text, title FROM public.knowledge_embeddings
           WHERE title ILIKE '%standardseedcorp%' OR content ILIKE '%standardseedcorp%';
