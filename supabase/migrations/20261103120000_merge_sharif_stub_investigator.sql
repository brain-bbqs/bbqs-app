-- #432: one person had two investigator records. The stub's name had an email address appended
-- ("Suliman Sharif (sulstice@standardseedcorp.com)"), which put the address in the public export.
-- Keep the MIT record, retire the stub. The stub holds no grants; its only unique datum is its
-- email, which is kept on the surviving record as a secondary address (not exported as a name).
-- The stub's auth.users login is NOT deleted here -- remove it in Dashboard > Authentication > Users.
-- All writes land in data_audit_log under the actor below. Runs as one transaction: any failed
-- check or FK violation rolls the whole merge back.
SELECT public.set_actor('migration:merge_sharif_stub_investigator');

DO $$
DECLARE
  _keep  constant uuid := '0ebb5b1a-b96b-41f6-a1b8-54b6e818b231';  -- sulstice@mit.edu, MIT
  _stub  constant uuid := '7d177d37-27a6-4b10-8763-74ab20844adf';  -- sulstice@standardseedcorp.com
  _stub_email text;
  _stub_res   uuid;
  _n          int;
BEGIN
  SELECT email, resource_id INTO _stub_email, _stub_res
    FROM public.investigators WHERE id = _stub AND name LIKE 'Suliman Sharif (%@%)';
  IF NOT FOUND THEN
    RAISE NOTICE 'stub investigator % not found (already merged?) -- nothing to do', _stub;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.investigators WHERE id = _keep AND lower(email) = 'sulstice@mit.edu') THEN
    RAISE EXCEPTION 'surviving record % is not sulstice@mit.edu; refusing to merge', _keep;
  END IF;

  SELECT count(*) INTO _n FROM public.grant_investigators WHERE investigator_id = _stub;
  IF _n > 0 THEN
    RAISE EXCEPTION 'stub still holds % grant link(s); repoint them before merging', _n;
  END IF;

  -- keep the address reachable on the surviving record
  UPDATE public.investigators
     SET secondary_emails = (SELECT array_agg(DISTINCT e)
                               FROM unnest(COALESCE(secondary_emails, '{}') || _stub_email) AS e),
         updated_at = now()
   WHERE id = _keep;

  -- history follows the person; transient rows of the stub are dropped
  UPDATE public.curation_audit_log SET investigator_id = _keep WHERE investigator_id = _stub;
  DELETE FROM public.access_request_matches WHERE investigator_id = _stub;
  DELETE FROM public.investigator_organizations WHERE investigator_id = _stub;

  DELETE FROM public.investigators WHERE id = _stub;

  -- the stub's spine row, only if nothing else points at it
  IF _stub_res IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.investigators WHERE resource_id = _stub_res) THEN
    DELETE FROM public.resources WHERE id = _stub_res;
  END IF;
END $$;

-- verify: expect 0 rows with an email in the name, and the surviving record carries the address
SELECT id, name, email, secondary_emails
  FROM public.investigators
 WHERE id = '0ebb5b1a-b96b-41f6-a1b8-54b6e818b231' OR name ~ '[^ ]+@[^ ]+';
